var _ = require('lodash');
var pathToRegexp = require('path-to-regexp');

function toSwagger(apidocJson, projectJson) {
	var swagger = {
		swagger	: "2.0",
		info	: {},
		paths	: {},
		definitions: {}
	};

	swagger.info = addInfo(projectJson);
	swagger.paths = extractPaths(swagger, apidocJson);
	addRemainingSwaggerProperties(swagger, projectJson);
	
	return swagger;
}

function addRemainingSwaggerProperties(swagger, projectJson) {
	if (projectJson.basePath) {
		swagger.basePath = projectJson.basePath;
	}

	if (projectJson.host) {
		swagger.host = projectJson.host;
	}

	if (projectJson.schemes) {
		swagger.schemes = projectJson.schemes;
	}
}

var tagsRegex = /(<([^>]+)>)/ig;
// Removes <p> </p> tags from text
function removeTags(text) {
	return text ? text.replace(tagsRegex, "") : text;
}

function addInfo(projectJson) {
	var info = {};
	info["title"] = projectJson.title || projectJson.name;
	info["version"] = projectJson.version;
	info["description"] = projectJson.description;
	return info;
}

/**
 * Extracts paths provided in json format
 * post, patch, put request parameters are extracted in body
 * get and delete are extracted to path parameters
 * @param apidocJson
 * @returns {{}}
 */
function extractPaths(swagger, apidocJson){
	var apiPaths = groupByUrl(apidocJson);
	var paths = {};
	for (var i = 0; i < apiPaths.length; i++) {
		var verbs = apiPaths[i].verbs;
		var url = verbs[0].url;
		var pattern = pathToRegexp(url, null);
		var matches = pattern.exec(url);

		// Surrounds URL parameters with curly brackets -> :email with {email}
		var pathKeys = [];
		for (var j = 1; j < matches.length; j++) {
			var key = matches[j].substr(1);
			url = url.replace(matches[j], "{"+ key +"}");
			pathKeys.push(key);
		}

		for(var j = 0; j < verbs.length; j++) {
			var verb = verbs[j];
			var type = verb.type.toLowerCase();

			var obj = paths[url] = paths[url] || {};

			if (type === 'post' || type === 'patch' || type === 'put') {
				_.extend(obj, createPostPushPutOutput(verb, swagger.definitions, pathKeys));
			} else {
				_.extend(obj, createGetDeleteOutput(verb, swagger.definitions));
			}
		}
	}
	return paths;
}

function createPostPushPutOutput(verb, definitions, pathKeys) {
	var pathItemObject = {};
	var verbDefinitionResult = createVerbDefinitions(verb, definitions);

	var params = [];
  params = params.concat(createPathParametersForPostPushPut(verb, pathKeys));
  params = params.concat(createQueryParameters(verb));

  // TODO: This condition should be changed or removed since it's assuming that parameters'll be sent in body.
	var required = verb.parameter && verb.parameter.fields && verb.parameter.fields.Parameter.length > 0;
	params.push({
			"in": "body",
			"name": "body",
			"description": removeTags(verb.description),
			"required": required,
			"schema": {
				"$ref": "#/definitions/" + verbDefinitionResult.topLevelParametersRef
			}
		});

	pathItemObject[verb.type] = {
		tags: [verb.group],
		summary: removeTags(verb.description),
		consumes: [
			"application/json"
		],
		produces: [
			"application/json"
		],
		parameters: params
	};

	if (verbDefinitionResult.topLevelSuccessRef) {
		pathItemObject[verb.type].responses = {
          "200": {
            "description": "successful operation",
            "schema": {
              "type": verbDefinitionResult.topLevelSuccessRefType,
              "items": {
                "$ref": "#/definitions/" + verbDefinitionResult.topLevelSuccessRef
              }
            }
          }
      	};
	}

	return pathItemObject;
}

function createPathParametersForPostPushPut(verb, pathKeys) {
  var pathParams = createPathParameters(verb);

  // Filter path parameters not defined in the path (it's considered that they'll be sent within the request's body)
  pathParams = _.filter(pathParams, function(param) {
    var hasKey = pathKeys.indexOf(param.name) !== -1;
    return !(param.in === "path" && !hasKey);
  });

  return pathParams;
}

function createVerbDefinitions(verb, definitions) {
	var result = {
		topLevelParametersRef : null,
		topLevelSuccessRef : null,
		topLevelSuccessRefType : null
	};
	var defaultObjectName = verb.name;

	var fieldArrayResult = {};
	if (verb && verb.parameter && verb.parameter.fields) {
		fieldArrayResult = createFieldArrayDefinitions(verb.parameter.fields.Parameter, definitions, verb.name, defaultObjectName);
		result.topLevelParametersRef = fieldArrayResult.topLevelRef;
	}

	if (verb && verb.success && verb.success.fields) {
		fieldArrayResult = createFieldArrayDefinitions(verb.success.fields["Success 200"], definitions, verb.name, defaultObjectName);
		result.topLevelSuccessRef = fieldArrayResult.topLevelRef;
		result.topLevelSuccessRefType = fieldArrayResult.topLevelRefType;
	}

	return result;
}

function createFieldArrayDefinitions(fieldArray, definitions, topLevelRef, defaultObjectName) {
	var result = {
		topLevelRef : topLevelRef,
		topLevelRefType : null
	};

	if (!fieldArray) {
		return result;
	}

	for (var i = 0; i < fieldArray.length; i++) {
		var parameter = fieldArray[i];

		var nestedName = createNestedName(parameter.field);
		var objectName = !nestedName.objectName ? defaultObjectName : nestedName.objectName;

		if (i === 0) {
			result.topLevelRefType = parameter.type;

			if(parameter.type == "Object") {
				objectName = nestedName.propertyName;
				nestedName.propertyName = null;
			} else if (parameter.type == "Array") {
				objectName = nestedName.propertyName;
				nestedName.propertyName = null;
				result.topLevelRefType = "array";
			}

			result.topLevelRef = objectName;
		}

		definitions[objectName] = definitions[objectName] || { properties : {}, required : [] };

    // FIXME: This condition is ALWAYS true because createdNestedName always returns a non-empty *propertyName*
		if (nestedName.propertyName) {
			var prop = { 
        type: (parameter.type || "").toLowerCase(), 
        description: removeTags(parameter.description) 
      };
      
			if(parameter.type == "Object") {
				prop.$ref = "#/definitions/" + parameter.field;
			}

			var typeIndex = parameter.type.indexOf("[]");
			if(typeIndex !== -1 && typeIndex === (parameter.type.length - 2)) {
				prop.type = "array";
				prop.items = {
					type: parameter.type.slice(0, parameter.type.length-2)
				};
			}

			definitions[objectName]['properties'][nestedName.propertyName] = prop;
			if (!parameter.optional) {
				var arr = definitions[objectName]['required'];
				if(arr.indexOf(nestedName.propertyName) === -1) {
					arr.push(nestedName.propertyName);
				}
			}

		}
	}

	return result;
}

/**
 * @param field
 *
 * @returns {{propertyName: *, objectName: *}}
 */
function createNestedName(field) {
	var propertyName = field;
	var objectName;
	var propertyNames = field.split(".");

	if(propertyNames && propertyNames.length > 1) {
		propertyName = propertyNames[propertyNames.length-1];
		propertyNames.pop();
		objectName = propertyNames.join(".");
	}

	return {
    propertyName: propertyName,
    objectName: objectName
  };
}


/**
 * Generate get, delete method output
 * @param verb
 * @param definitions
 * @returns {{}}
 */
function createGetDeleteOutput(verb, definitions) {
	var pathItemObject = {};
	verb.type = verb.type === "del" ? "delete" : verb.type;

  var params = [];
  params = params.concat(createPathParameters(verb));
  params = params.concat(createQueryParameters(verb));

	var verbDefinitionResult = createVerbDefinitions(verb, definitions);
	pathItemObject[verb.type] = {
		tags: [verb.group],
		summary: removeTags(verb.description),
		consumes: [
			"application/json"
		],
		produces: [
			"application/json"
		],
		parameters: params
	};

	if (verbDefinitionResult.topLevelSuccessRef) {
		pathItemObject[verb.type].responses = {
          "200": {
            "description": "successful operation",
            "schema": {
              "type": verbDefinitionResult.topLevelSuccessRefType,
              "items": {
                "$ref": "#/definitions/" + verbDefinitionResult.topLevelSuccessRef
              }
            }
          }
      	};
	}

	return pathItemObject;
}

/**
 * Iterate through all method parameters and create array of parameter objects which are stored as path parameters
 * @param verbs
 * @returns {Array}
 */
function createPathParameters(verbs) {
	var pathItemObject = [];

  if (verbs.parameter && verbs.parameter.fields && verbs.parameter.fields.Parameter) {

		for (var i = 0; i < verbs.parameter.fields.Parameter.length; i++) {
			var param = verbs.parameter.fields.Parameter[i];

			pathItemObject.push({
				name: param.field,
				in: param.type.toLowerCase() === "file" ? "formData" : "path",
				required: !param.optional,
				type: param.type.toLowerCase(),
				description: removeTags(param.description)
			});

		}
	}

	return pathItemObject;
}

/**
 * Detect all method parameters within group *QueryParameter* and add them as query parameters
 * @param verb
 * @returns {Array}
 */
function createQueryParameters(verb) {
  var swaggerQueryParameters = [];

  if (verb.parameter && verb.parameter.fields && verb.parameter.fields.QueryParameter) {

    for (var i = 0; i < verb.parameter.fields.QueryParameter.length; i++) {
      var param = verb.parameter.fields.QueryParameter[i];

      swaggerQueryParameters.push({
        name: param.field,
        in: "query",
        required: !param.optional,
        type: param.type.toLowerCase(),
        description: removeTags(param.description)
      });

    }
  }

  return swaggerQueryParameters;
}

function groupByUrl(apidocJson) {
	return _.chain(apidocJson)
		.groupBy("url")
		.pairs()
		.map(function (element) {
			return _.object(_.zip(["url", "verbs"], element));
		})
		.value();
}

module.exports = {
	toSwagger: toSwagger
};
