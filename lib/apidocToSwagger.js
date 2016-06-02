/* jshint node: true */

var _ = require('lodash');
var pathToRegexp = require('path-to-regexp');

/**
 *
 * @param {String} type
 * @returns {Object} Swagger datatype { type: "string", format: "string" }
 */
function findSwaggerDataType(type) {
  var swaggerDataTypes = {
    integer:  { type: "integer",  format: "int32" },
    long:     { type: "integer",  format: "int64" },
    float:    { type: "number",   format: "float" },
    double:   { type: "number",   format: "double" },
    string:   { type: "string",   format: "" },
    byte:     { type: "string",   format: "byte" },
    binary:   { type: "string",   format: "binary" },
    boolean:  { type: "boolean",  format: "" },
    date:     { type: "string",   format: "date" },
    dateTime: { type: "string",   format: "date-time" },
    password: { type: "string",   format: "password" },
    object:   { type: "object" },
    file:     { type: "file" }
  };

  if (!type) {
    return swaggerDataTypes.string;
  }

  switch (type.toLowerCase()) {
    case 'datetime':
    case 'date-time':
      return swaggerDataTypes.dateTime;
    case 'number':
      return swaggerDataTypes.integer;
    default:
      return swaggerDataTypes[type.toLowerCase()] ? swaggerDataTypes[type.toLowerCase()] : swaggerDataTypes.string;
  }
}

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
	var required = verb.parameter && verb.parameter.fields && verb.parameter.fields.Parameter && verb.parameter.fields.Parameter.length > 0;
	params.push({
			"in": "body",
			"name": "body",
			"description": "Request body",
			"required": required,
			"schema": {
				"$ref": "#/definitions/" + verbDefinitionResult.topLevelParametersRef
			}
		});

	pathItemObject[verb.type] = {
		tags: [verb.group],
    summary: removeTags(verb.title),
    description: verb.description,
		consumes: [
			"application/json"
		],
		produces: [
			"application/json"
		],
		parameters: params
	};

  pathItemObject[verb.type].responses = createSwaggerResponses(verbDefinitionResult, verb);

	return pathItemObject;
}

function createSwaggerResponses(verbDefinitionResult, verb) {
  // if (verbDefinitionResult.topLevelSuccessRef) {
  //   pathItemObject[verb.type].responses = {
  //     "200": {
  //       "description": "successful operation",
  //       "schema": {
  //         "type": verbDefinitionResult.topLevelSuccessRefType,
  //         "items": {
  //           "$ref": "#/definitions/" + verbDefinitionResult.topLevelSuccessRef
  //         }
  //       }
  //     }
  //   };
  // }

  if (!verb) {
    return {};
  }

  var swaggerResponses = {};

  if (verb.success && verb.success.fields) {
    for (var successResponseGroup in verb.success.fields) {
      if (verb.success.fields.hasOwnProperty(successResponseGroup)) {
        // NOTE: Consider only the first Response of the group. Alternative, use the apidoc 'field' for the response code
        var successResponse = verb.success.fields[successResponseGroup][0],
          responseCode = successResponse.group && successResponse.group.toLowerCase() === "success 200" ? "200" : successResponse.group;
        swaggerResponses[responseCode] = createSwaggerResponse(successResponse);
      }
    }
  } else {
    swaggerResponses["default"] = {
      "description": "successful operation"
    };
  }

  if (verb.error && verb.error.fields) {
    for (var errorResponseGroup in verb.error.fields) {
      if (verb.error.fields.hasOwnProperty(errorResponseGroup)) {
        // NOTE: Consider only the first Response of the group. Alternative, use the apidoc 'field' for the response code
        swaggerResponses[errorResponseGroup] = createSwaggerResponse(verb.error.fields[errorResponseGroup][0]);
      }
    }
  }

  return swaggerResponses;
}

function createSwaggerResponse(apiDocResponse) {
  var swaggerResponse = {},
      defaultType = "string";

  if (apiDocResponse.description) {
    swaggerResponse["description"] = apiDocResponse.description;
  }

  if (apiDocResponse.type) {
    if (apiDocResponse.type.toLowerCase() === "object") {
      swaggerResponse["schema"] = {
        "$ref": "#/definitions/" + apiDocResponse.field
      };
    } else if (typeIsArray(apiDocResponse.type)) {
      var typeOfArray = apiDocResponse.type.slice(0, apiDocResponse.type.length - 2).toLowerCase();

      swaggerResponse["schema"] = {
        "type": "array",
        "items": {
          "$ref": typeOfArray === 'object' ? "#/definitions/" + apiDocResponse.field : typeOfArray
        }
      };
    } else {
      var swaggerDataType = findSwaggerDataType(apiDocResponse.type);
      swaggerResponse["schema"] = {
        "type":   swaggerDataType.type,
        "format": swaggerDataType.format
      };
    }
  } else {
    var swaggerDataType = findSwaggerDataType(defaultType);
    swaggerResponse["schema"] = {
      "type":   swaggerDataType.type,
      "format": swaggerDataType.format
    };
  }

  return swaggerResponse;
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
		// FIXME: "Success 200" shouldn't be use a default case, there are endpoints which success response code could be different
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

    // TODO: replace all 'parameter.type.toLowerCase' with a local variable
		if (i === 0) {
			result.topLevelRefType = parameter.type;

			if(parameter.type.toLowerCase() == "object") {
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

    // FIXME: This condition will be false ONLY when FIRST parameter's type is Object or Array. 'createdNestedName' ALWAYS returns a not-null 'propertyName'
		if (nestedName.propertyName) {
      var prop = {
        description: removeTags(parameter.description)
      };

      if(typeIsArray(parameter.type)) {
        prop.type = "array";
        if (parameter.type.toLowerCase().indexOf("object") > -1) {
          prop.items = {
            "$ref": "#/definitions/" + (nestedName.objectName ? nestedName.propertyName : parameter.field)
          };
        } else {
          prop.items = {
            type: parameter.type.slice(0, parameter.type.length - 2)
          };
        }
      } else if(parameter.type.toLowerCase() === "object") {
        prop.type = (parameter.type || "").toLowerCase();
        // propertyName is used because it's an embeded object, then we need to refer to it
        prop.$ref = "#/definitions/" + (nestedName.objectName ? nestedName.propertyName : parameter.field);
      } else {
        var swaggerType = findSwaggerDataType(parameter.type);
        prop.type = swaggerType.type;
        prop.format = swaggerType.format;
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

function typeIsArray(type) {
  var typeIndex = type.indexOf("[]");
  return (typeIndex !== -1 && typeIndex === (type.length - 2));
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
    summary: removeTags(verb.title),
    description: verb.description,
		consumes: [
			"application/json"
		],
		produces: [
			"application/json"
		],
		parameters: params
	};

  pathItemObject[verb.type].responses = createSwaggerResponses(verbDefinitionResult, verb);

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
      var swaggerDataType = findSwaggerDataType(param.type);

			pathItemObject.push({
				name: param.field,
				in: param.type.toLowerCase() === "file" ? "formData" : "path",
				required: !param.optional,
				type:   swaggerDataType.type,
        format: swaggerDataType.format,
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
      var swaggerDataType = findSwaggerDataType(param.type);

      swaggerQueryParameters.push({
        name: param.field,
        in: "query",
        required: !param.optional,
        type:   swaggerDataType.type,
        format: swaggerDataType.format,
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
