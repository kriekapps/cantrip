var express = require('express');
var _ = require("underscore");
var fs = require('fs');
var md5 = require('MD5');
var cors = require('cors');
var io = require("socket.io");
var crypto = require("crypto");

//Set up express
var app = express();
app.configure(function() {
	app.use(express.json());
	app.use(function(err, req, res, next) {
		res.status(400);
		res.send({
			"error": "Invalid JSON supplied in request body."
		});
		next(err);
	});
	app.use(express.urlencoded());
	app.use(express.multipart());
	app.use(cors());
});



var Cantrip = {
	options: {
		port: process.env.PORT || 3000,
		saveEvery: 1,
		file: "data.json"
	},
	/**
	 * Starts the server. Sets up the data in memory, creates a file if necessary
	 */
	start: function() {

		//Override options from command line arguments
		var self = this;
		process.argv.forEach(function(val, index, array) {
			if (val.indexOf("=") > -1) {
				var option = val.split("=");
				self.options[option[0]] = option[1];
			}
		});

		//Set up memory by reading the contents of the file
		if (!fs.existsSync(this.options.file)) {
			fs.writeFileSync(this.options.file, "{}");
		}

		this.data = fs.readFileSync(this.options.file, {
			encoding: 'utf-8'
		});
		this.data = JSON.parse(this.data);

		//Set up the server
		this.app = app;

		//Get to the target node and save all nodes in between
		app.use(this.nodes);
		//Access Control
		app.use(this.acl);


		//Set up a get hook on all default paths
		app.get('*', function(request, response) {
			Cantrip.get(request, response);
		});

		app.post("/_auth/signup", function(request, response, next) {
			Cantrip.userManagement.signup(request, response, next);
		});

		app.post("/_auth/login", function(request, response, next) {
			Cantrip.userManagement.login(request, response, next);
		});

		app.post("*", function(request, response) {
			Cantrip.post(request, response);
		});

		app.delete("*", function(request, response) {
			Cantrip.delete(request, response);
		});

		app.put("*", function(request, response) {
			Cantrip.put(request, response);
		});

		//Start the server
		var server = this.app.listen(this.options.port);

		//Start socket io service too
		this.io = io.listen(server);

	},
	nodes: function(req, res, next) {
		//Parse the path and save it on the request
		req.pathMembers = _.filter(req.url.split("/"), function(string) {
			return string !== "";
		});
		var path = req.pathMembers;

		//Get the root element based on several factors: whether we have _contents in the JSON, did we try to access something inside a _meta parameter
		//By default the root is the whole JSON
		var route = Cantrip.data;
		//If we're trying to access a meta object
		if (path.length > 0 && path[0][0] === "_") {
			//Set the root object to that meta object, or throw an error if it doesn't exist
			if (Cantrip.data[path[0]]) {
				route = Cantrip.data[path[0]];
				var metaObject = path.shift();
			} else {
				res.status(404).send({
					"error": "Requested meta object doesn't exist."
				});
			}
			//If the first member of the url is not a meta object key, then check if we have _contents
		} else if (Cantrip.data._contents) {
			route = Cantrip.data._contents;
		}

		req.nodes = []; //This array holds all nodes until we get to the target node

		//If the remainin path's length is zero (so we are on the root), pass in the whole object
		if (path.length === 0) {
			req.nodes.push(route);
		}
		//Loop through the data by the given paths
		for (var i = 0; i < path.length; i++) {
			var temp = route[path[i]];
			//If we found the given key, assign the route object to its value
			if (temp !== undefined) {
				route = route[path[i]];
				//If the given key doesn't exist, try the _id
			} else {
				temp = _.find(route, function(obj) {
					return obj._id === path[i];
				});
				//If it's not undefined, then assign it as the value
				if (temp !== undefined) {
					route = temp;
				} else {
					//If it's still undefined, return
					res.status(404).send({
						"error": "Requested node doesn't exist."
					});
					return;
				}
			}
			req.nodes.push(route);
		}

		//If the first member of the url was a _meta object, readd it to the beginning of the path array, so other middlewares still see the full path
		if (metaObject) {
			path.unshift(metaObject);
		}

		next();
	},
	//Save the JSON in memory to the specified JSON file. Runs after every API call, once the answer has been sent.
	//Uses the async writeFile so it doesn't interrupt other stuff.
	//If options.saveEvery is different from 1, it doesn't save every time.
	//If options.saveEvery is 0, it never saves
	counter: 0,
	saveData: function() {
		if (++this.counter === this.options.saveEvery && this.options.saveEvery !== 0) {
			fs.writeFile(this.options.file, JSON.stringify(this.data), function(err) {
				if (err) {
					console.log(err);
				}
			});
			this.counter = 0;
		}
	},
	get: function(req, res) {
		var target = _.last(req.nodes);
		if (_.isObject(target) || _.isArray(target)) {
			res.send(target);
		} else if (target) {
			res.send({
				value: target
			});
		}
	},
	post: function(req, res) {
		var target = _.last(req.nodes);
		//If it's an array, post the new entry to that array
		if (_.isArray(target)) {
			//Add ids to all objects within arrays in the sent object
			this.addMetadataToModels(req.body);
			//If the posted body is an object itself, add an id to it
			if (_.isObject(req.body) && !_.isArray(req.body)) {
				//Extend the whole object with an _id property, but only if it doesn't already have one
				req.body = _.extend({
					_id: md5(JSON.stringify(req.body) + (new Date()).getTime() + Math.random()),
					_createdDate: (new Date()).getTime(),
					_modifiedDate: (new Date()).getTime()
				}, req.body);
			}
			//Check if the given ID already exists in the collection
			for (var i = 0; i < target.length; i++) {
				if (target[i]._id === req.body._id) {
					res.status(400).send({
						"error": "An object with the same _id already exists in this collection."
					});
					return;
				}
			}
			//Push it to the target array
			target.push(req.body);
			//Emit socketio event
			this.io.sockets.emit("POST:/" + req.path, req.body);
			//Send the response
			res.send(req.body);
			//Start saving the data
			this.saveData();
		} else {
			res.status(400).send({
				"error": "Can't POST to an object. Use PUT instead."
			});
		}
	},
	put: function(req, res) {
		var target = _.last(req.nodes);
		if (_.isObject(target)) {
			this.addMetadataToModels(req.body);
			//If the target had previously had a _modifiedDate property, set it to the current time
			if (target._modifiedDate) target._modifiedDate = (new Date()).getTime();
			target = _.extend(target, req.body);
			//Send the response
			res.send(target);
			//Emit socketio event
			this.io.sockets.emit("PUT:/" + req.path, target);
			//Start saving the data
			this.saveData();
		} else {
			res.status(400).send({
				"error": "Can't PUT a collection."
			});
		}
	},
	delete: function(req, res) {
		//Get the parent node so we can unset the target
		var parent = req.nodes[req.nodes.length - 2];
		//Last identifier in the path
		var index = _.last(req.pathMembers);
		//If it's an object (not an array), then we just unset the key with the keyword delete
		if (_.isObject(parent) && !_.isArray(parent)) {
			//We're not letting users delete the _id
			if ((index + "")[0] === "_") {
				res.status(400).send({
					"error": "You can't delete an object's metadata."
				});
			} else {
				parent = _.omit(parent, index);
			}
			//If it's an array, we must remove it by id with the splice method	
		} else if (_.isArray(parent)) {
			//If the index is a number, index will be the actual index in the array
			if (_.isNumber(Number(index)) && !_.isNaN(Number(index))) {
				parent.splice(index, 1);
				//If it's a hash (string), we find the target object, get it's index and remove it from the array that way
			} else {
				var obj = _.find(parent, function(obj) {
					return obj._id === index;
				});
				parent.splice(_.indexOf(parent, obj), 1);
			}
		}
		//Send the response
		res.send(parent);
		//Emit socketio event
		this.io.sockets.emit("DELETE:/" + req.path, parent);
		//Start saving the data
		this.saveData();
	},
	//Recursively add _ids to all objects within an array (but not arrays) within the specified object.
	addMetadataToModels: function(obj) {
		//Loop through the objects keys
		for (var key in obj) {
			//If the value of the key is an array (means it's a collection), go through all of its contents
			if (_.isArray(obj[key])) {
				for (var i = 0; i < obj[key].length; i++) {
					//Assign an id to all objects
					if (_.isObject(obj[key][i]) && !_.isArray(obj[key][i])) {
						obj[key][i] = _.extend({
							_id: md5(JSON.stringify(obj[key][i]) + (new Date()).getTime() + Math.random()),
							_createdDate: (new Date()).getTime(),
							_modifiedDate: (new Date()).getTime()
						}, obj[key][i]);
						//Modify the _modifiedDate metadata property
						obj[key][i]._modifiedDate = (new Date()).getTime();
					}
				}
				//If it's an object, call the recursive method with that object
			} else if (_.isObject(obj[key])) {
				this.addMetadataToModels(obj[key]);
			}
		}
	},
	/**
	 * This middleware makes sure that the user making a request is authorized to do so.
	 * Restrictions to paths are stored in the _acl meta object.
	 * By default every user can do anything.
	 */
	acl: function(req, res, next) {
		//Check if there is an Authorization header or the token is passed in as the GET parameter accessToken
		if (req.get("Authorization") || req.query.accessToken) {
			var token = req.get("Authorization") ? req.get("Authorization").split(" ")[1] : req.query.accessToken;
			try {
				var user = Cantrip.decrypt(token);
			} catch (err) {
				var user = undefined;
			}
			if (user && user.expires > (new Date()).getTime()) {
				req.user = _.find(Cantrip.data._users, function(u) {
					return u._id === user._id
				});
			} else {
				req.user = {
					roles: ["unknown"]
				};
			}
		} else {
			req.user = {
				roles: ["unknown"]
			};
		}
		var acl = Cantrip.data._acl;
		var url = req.path;
		//strip "/" character from the end of the url
		if (url[url.length - 1] === "/") url = url.substr(0, url.length - 1);

		var foundRestriction = false; //This indicates whether there was any restriction found during the process. If not, the requests defaults to pass.
		//Loop through all possible urls starting from the beginning, eg: /, /users, /users/:id, /users/:id/comments, /users/:id/comments/:id.
		for (var i = 0; i < url.split("/").length; i++) {
			//Get the current url fragment
			var fragment = _.first(url.split("/"), (i + 1)).join("/");
			if (fragment === "") fragment = "/"; //fragment for the root element
			//Build a regex tht will be used to match urls in the _acl table
			var regex = "^";
			fragment.substr(1).split("/").forEach(function(f) {
				if (f !== "") {
					regex += "/(" + f + "|:[a-zA-Z]+)";
				}
			});
			regex += "$";
			if (regex === "^$") regex = "^/$"; //regex for the root element
			var matcher = new RegExp(regex);
			//Loop through the _acl table
			for (var key in acl) {
				if (key.match(matcher)) {
					if (acl[key][req.method]) {
						foundRestriction = true;
						//Check if the user is in a group that is inside this restriction
						if (_.intersection(req.user.roles || [], acl[key][req.method]).length > 0) {
							next();
							return;
						}

						//Check if the user is the owner of the object, when "owner" as a group is specified
						if (acl[key][req.method].indexOf("owner") > -1) {
							var target = _.last(req.nodes);
							if (target._owner === req.user._id) {
								next();
								return;
							}
						}
					}
				}
			}
		}

		//Check if we found any restrictions along the way
		if (foundRestriction) {
			res.status(403).send({
				"error": "Access denied."
			});
		} else {
			next();
		}
	},

	userManagement: {
		signup: function(req, res, next) {
			//Redirect to write to the _users node instead
			req.nodes = [Cantrip.data._users];
			//Check for required password field
			if (!req.body.password) {
				res.status(400).send({
					"error": "Missing required field: password."
				});
				return;
			}
			//Create password hash
			req.body.password = md5(req.body.password + "" + Cantrip.data._salt);
			//If it's not an array or doesn't exist, create an empty roles array
			req.body.roles = [];
			next();
		},
		login: function(req, res, next) {
			var user = _.find(Cantrip.data._users, function(u) {
				return u._id === req.body._id
			});
			if (!user || user.password !== md5(req.body.password + "" + Cantrip.data._salt)) {
				res.status(400).send({
					"error": "Wrong _id or password."
				});
				return;
			}
			var toCrypt = {
				_id: user._id,
				roles: user.roles,
				expires: (new Date()).getTime() + 1000 * 60 * 60 * 24
			}

			res.send({
				token: Cantrip.encrypt(toCrypt)
			});
		}
	},

	encrypt: function(obj) {
		var cipher = crypto.createCipher('aes-256-cbc', this.data._salt);
		var crypted = cipher.update(JSON.stringify(obj), 'utf8', 'hex')
		crypted += cipher.final('hex');
		return crypted;
	},

	decrypt: function(string) {
		var decipher = crypto.createDecipher('aes-256-cbc', this.data._salt);
		var dec = decipher.update(string, 'hex', 'utf8')
		dec += decipher.final('utf8');
		return JSON.parse(dec);
	}
}

module.exports = Cantrip;