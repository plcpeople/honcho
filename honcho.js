/*!
 * Honcho
 *
 * Multiple PLC Manager
 *
 */

/**
 * Module dependencies
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const async = require('async');

/**
 * Expose
 */
exports = module.exports;

/**
 * Current active subscription collection
 */
var subscriptions = {};

/**
 * PLC interface collection
 */
var controllers = {};

/**
 * Regular Expression for path matching tags to controllers
 */
var TAGREG = new RegExp(/^([\w-]+)\/(.+)$/);


/**
 * TAG CACHE
 */
var tagCache = {};

/**
 * Tag File Cache
 * Pointers to Conntroller Tags keyed on the tagfile path
 * Allows for multiple controllers to use the same lookup saving memory and
 * startup time on large tag files.
 */
var tagFileLookCache = {};

/**
 * Absolute path to tag file directory
 */
var tagFileDir;

/**
 * Honcho
 * Public API
 */

/**
  * From a configuration object, for each specified controller create a connection using its particular driver program.
  * @param {object} config The required configuration object. See README for more info.s
  * @param {function} cb 
  */
exports.configure = function(config, cb) {

  console.log('configuring ' + config.controllers.length +' controllers');

  tagFileDir = config.tagFileDir;

  async.each(config.controllers, function(ctrl, cback) {
    if(ctrl){
      controllers[ctrl.connection_name] = new Controller(ctrl, (err) => {
        if (err) {
          console.log(`ERROR: Controller ${ctrl.connection_name} configuration error ${err.code}`);
        }
        cback();
      });
    }else{
      cback();// Could cback('Null controller')?
    }
  }, (err) => {
    if (err) {
      console.log('An error was received processing controllers in honcho');
    }
    controllers['default'] = controllers[config.defaultController];
    cb();
  });
}

function bounce(n){return n;}

 /**
  * Constructs a  new controller connection using it's denoted driver.
  * @param {object} conf The honcho configuration.
  * @param {function} cb Callback when finished
  */
function Controller(conf, cb) {
  var self = this;
  var tagfile;

  var Conn = require(conf.type);
  self.conn = new Conn({silent: conf.silent, debug: conf.debug});  // NodeS7 uses these options in the constructor
  self.conn.setTranslationCB(bounce);
  self.cparams = conf;  // Passing the entire object, not just port and host, allows protocol-specific options

  // bind controller functions to Connection
  ['addItems','removeItems', 'readAllItems', 'findItem', 'writeItems'].forEach((method) => {
    self[method] = self.conn[method].bind(self.conn);
  });

  tagfile = path.join(tagFileDir, conf.tagfile);

  if(tagFileLookCache[tagfile]){
    //console.log('Loading Shared Tags '+tagfile);
    self.tags = tagFileLookCache[tagfile];
    self.conn.initiateConnection(self.cparams, cb);
  }else{
    var l,m, input;
    self.tags = {};
    input = fs.createReadStream(tagfile);
    readLines(input, (data, done) => {
      l = data.toString().replace(/\s/g,'');
      m = l.match(/^([A-Z|a-z|0-1|_].+)=(.+)$/);
      if(m){
        self.tags[m[1]]=m[2];
      }
      if(done){
        tagFileLookCache[tagfile] = self.tags;
        self.conn.initiateConnection(self.cparams, cb);
      }
    });
  }
}

 /**
  * @ignore To simulate a slow read
  * @param {function} cb Callback when finished
  */
Controller.prototype.simulateSlowReadAllItems = function(cb) {
  var self = this;
  setTimeout(() => {
    self.readAllItems(cb);
  }, 500);
}

 /**
  * Create a poll for a particular controller
  * @param {object} packet A controller packet
  * @param {function} cb Callback with results of each poll
  * @param {number} timeout Polling timeout (ms)
  */
Controller.prototype.createPoll = function(packet,  cb, timeout) {
  var self = this;
  var values = packet.values;
  var tags = packet.tags;
  var tick;

  self.addItems(values);

  function poll(ts){
    tick = Date.now();
    // toggle this to simulate slow results
    //self.simulateSlowReadAllItems(
    // console.log(self.ts);

    self.readAllItems(() => {
      var results = {}, value;
      for(var i=0; i < values.length; i++){
        value = self.findItem(values[i]);
        if(typeof value === 'undefined'){
          results[tags[i]] = 'UNDF';
        }
        else if(value.quality != 'OK'){
          results[tags[i]] = value.quality;
        }
        else{
          results[tags[i]] = value.value;
        }
      }
      diff = Math.max(timeout-(Date.now()-tick),0);
      diff = Math.min(diff,timeout);  // In case clock changes while running
      //console.log(diff);
      cb(null, results);
      if(self.ts == ts){
        self.ts = Date.now();
        self.pollId = setTimeout(poll, diff, self.ts);
      }
    });
  }
  poll();
}

 /**
  * Clear an existing poll.
  */
Controller.prototype.clearPoll = function(){
  var self = this;
  self.ts = null;
  clearTimeout(self.pollId);
}

 /**
  * Returns the full "item" from a tag's PLC driver in a callback.
  * @param {string | string[]} tags Either a single tag (string) or multiple tags (string[]) 
  * @param {function} cb 
  */
exports.findItem = function(tags, cb){
  tags = [].concat(tags);
  generateControllerPackets(tags, (err, controllerPackets) => {
    if(err){
      console.log(err);
    }
    findPackets(controllerPackets, cb);
  });
}

/**
  * Read tag(s) from the managed controllers., callback with values.
  * @param {string | string[]} tags Either a single tag (string) or an array of tags (string[])
  * @param {function} cb 
  * @returns If parameter: tags is not an array or string. 
  */
exports.read = function(tags, cb){
  // register tags for lookup against controller
  if(typeof tags !== 'string' && toString.call(tags) !== '[object Array]'){
    cb(new Error('@tags must to be a String or an Array'));
    return;
  }
  
  tags = [].concat(tags);   // cast tags to array
  generateControllerPackets(tags, (err, controllerPackets) => {
    if(err){
      console.log("ERROR:", err);
    }
    readPackets(controllerPackets, cb);
  });
}

/**
  * Write a value to a single tag. Note: the tag's controller configuration object must have allowWrite=true to be successful.
  * @param {string} tag The tag to be written to.
  * @param {any} value The value being written, make sure datatypes line up. 
  * @param {function} cb Callback with an error, if any.
  */
exports.write = function(tag, value, cb){
  tagLookup(tag, (err, tagObj) => {
    if (err) {
      cb(err);
    } else {
      if (tagObj.ctrl && controllers[tagObj.ctrl].cparams.allowWrite) {
        controllers[tagObj.ctrl].writeItems(tagObj.value, value, cb);
      } else {
        var message = `ERROR: Writing to ${tag} on controller ${controllers[tagObj.ctrl].cparams.connection_name} prohibited; connection parameter 'allowWrite' is disabled.`;
        cb(new Error(message));
      }
    }
  });
}

/**
  * Write any number of tags at once. Given an object mapping a tag name to the desired value. Tags can span multiple controllers on the network. 
  * 
  * DOES NOT fail on single controller write error unless you call done(err).
  * 
  * @param {object<string, any} items An object containing tag names as strings and the value: {  }
  * @param {function} cb Callback once all tags and controllers have been written to. 
  */
 exports.writeItems = function(items, cb) {
  var tags = Object.keys(items);
  generateControllerPackets(tags, (err, controllerPackets) => {
    if (err) {
      console.log("ERROR:", err);
    }
    var ctrls = Object.keys(controllerPackets).filter(c => c.length);
    async.each(
      ctrls, 
      (key, done) => {
        var thisController = controllers[key];
        var addresses = controllerPackets[key].values;

        var controllerValues = [];
        controllerPackets[key].tags.forEach((tag) => {
          controllerValues.push(items[tag]);
        });

        if (thisController.cparams.allowWrite) {
          thisController.writeItems(addresses, controllerValues, (err) => {
            if (err) {
              console.log(`ERROR: Detected bad qualities when writing values to ${thisController.cparams.connection_name}`);
            }
            done();
          });
        } else {
          console.log(`ERROR: Cannot write to controller ${thisController.cparams.connection_name}; connection parameter 'allowWrite' is disabled.`);
          done();
        }
      },
      (err) => cb(err)
    )
  });
}

 /**
  * Create a subscription for tags which can belong to numerous controllers/protocols.
  * @param {string[]} tags The list of tags to subscribe to 
  * @param {function} cb 
  * @param {number} timeout Optional timeout parsmeter if no connection an be 
  * @param {function} callCBAnyway 
  * @returns A subscription token (digest)
  */
exports.createSubscription = function(tags, cb, timeout, callCBAnyway) {

  if(typeof timeout === 'undefined'){
    timeout = 0;
  }

  // skip match requests for the same tag data
  token = crypto.createHash('md5').update(String(tags)).digest('hex');
  if(subscriptions[token]){
    return;
  }

  generateControllerPackets(tags, (err, controllerPackets) => {
    subscriptions[token] = {
      ts:Date.now(),
      controllerPackets: controllerPackets
    }

    if(err){
      console.log(err);
    }
    Object.keys(controllerPackets).forEach((key) => {
        if (controllers[key]) {
          controllers[key].createPoll(controllerPackets[key], cb, timeout);
        } else if (callCBAnyway) {
          setInterval(() => cb(null, {}), timeout);
        }
    });
  });

  return token;
}

 /**
  * Remove an existing subscription.
  * @param {string} token The token for the subscription to be cancelled.
  */
exports.removeSubscription = function(token) {
  var controllerPacketSubscription = subscriptions[token];
  if(typeof controllerPacketSubscription === 'undefined'){
    throw new Error('A valid token must be supplied to remove a subscription');
  }
  Object.keys(controllerPacketSubscription.controllerPackets).forEach((key) => {
    controllers[key] && controllers[key].clearPoll(); // It is possible to have undefined controllers here now.
  });
}

/**
  * Not implemented
  * @param {*} parent 
  * @param {*} cb 
  */
exports.browse = function(parent, cb) {
  var tagset = [];
  if(typeof cb === "undefined" && typeof parent === "function") {
    cb = parent;
  }
  if(typeof cb !== "function"){
    throw new Error("You must specify a callback");
  }
  if(typeof parent === 'string'){
    // TODO: filter tags by parent
  }else{
    // clone root tags
  }
  cb(tagset);
}

/**
  * Get all tags from all controllers.
  * @returns All tags arranged by controller.
  */
exports.alltags = function() {
	var tagobj = {};
	Object.keys(controllers).forEach((ct) => {
        if (ct !== "default") {
            tagobj[ct] = controllers[ct].tags;
        }
	});
	return tagobj;
}

 /* INTERNAL functions */

 /**
  * Use controller specific protocol to get 
  * @param {object} controllerPackets 
  * @param {function} cb 
  */
function findPackets(controllerPackets, cb) {
  Object.keys(controllerPackets).forEach((key) => {
    var values = controllerPackets[key];
    controllers[key].findItem(values, cb);
  });
}

 /**
  * Send tags to their controller protocol and calls back with an object containing 
  * @param {object} controllerPackets See generateControllerPackets
  * @param {function} cb With err (if any) and tag/value object for all controllers
  */
function readPackets(controllerPackets, cb) {
  var allValues = {};
  var ctrls = Object.keys(controllerPackets).filter(c => c.length); // remove undefined controllers; caused by malformed tags that do not belong to any configured controller.
  async.each(
    ctrls,
    (key, done) => {  // key is the individual controller from the loop
       var addresses = controllerPackets[key].values;
       var tags = controllerPackets[key].tags;
 
       controllers[key].addItems(addresses);
       controllers[key].readAllItems((err, vals) => {
         // if (err) { done(err); } // If you want to fail and stop other controllers when one errors
         var results = {}
         addresses.forEach((addr, i) => {
           results[tags[i]] = vals[addr] ?? "UNDF";
         });
         allValues = Object.assign(allValues, results);
         done();
       });
     },
     (err) => cb(err, allValues)
    );
}

 /**
  * Generates an array of tags (and their address/type) associated to a controller.
  * @param {string[]} tags The tags we are organizing packets for. 
  * @param {function} cb With an error (if one) and the packets organized by controller. 
  */
function generateControllerPackets(tags, cb) {
  var controllerPackets = {};
   async.each(
     tags,
     (tag, done) => {
       tagLookup(tag, (err, packet) => {
         if (err) {
           console.log(err);
         } else {
           var p = controllerPackets[packet.ctrl] || {};
           p.values = p.values || [];
           p.values.push(packet.value);
           p.tags = p.tags || [];
           p.tags.push(tag);
           controllerPackets[packet.ctrl] = p;
         }
         done();
       });
     },
     (err) => cb(err, controllerPackets)
   );
}

 /**
  * Lookup a single tag. Note passthrough is so that one can lookup a tag not defined in a controller's tag alias text file.
  * @param {string} tag The tag we are looking up.
  * @param {function} cb Callback with params (err, val) where val is tag data. 
  * @returns If a tag is defined in honcho's chache (memory) and no further action is needed.
  */
function tagLookup(tag, cb){
  var ctrl, packet, m;

  packet = tagCache[tag];
  if(packet){
    //console.log(tag,'from cache');
    cb(null, packet);
    return;
  }

  // first check default controller
  ctrl = controllers['default'];
  if(ctrl && ctrl.tags && ctrl.tags[tag]){
    tagCache[tag] = {ctrl:'default',value:ctrl.tags[tag]};
    cb(null, tagCache[tag]);
    return;
  }

  // check other controllers
  m=TAGREG.exec(tag);
  //console.log(m);
  if (!m) {
    console.log("Not on Default Controller and None Specified:", tag);
    m = [tag, '', tag]; // Arrange the array with no controller
    //cb(new Error("INVALID TAG FORMAT"));  // Callback here to fully disable pass through
    //return;
  }

  ctrl = controllers[m[1]];
  if(typeof ctrl === 'undefined' || typeof ctrl.tags[m[2]] === 'undefined'){
      if (typeof ctrl !== 'undefined') {  // Valid controller and invalid tag specification
          console.log("ctrl.tags[m[2]]");
          // no point logging undefined.        console.log(ctrl.tags[m[2]]);
          if (ctrl.tagPassThrough) {
            console.log("Passthrough enabled - tag found that isn't defined on the controller so we are assuming it's an address:");
            console.log(m[2]);
            ctrl.tags[m[2]] = m[2];
          } else {
            console.log("Passthrough not enabled - tag found that isn't defined on the controller:");
            console.log(m[2]);
          }
      } else {
          console.log("Undefined controller");
      }

      if (!ctrl) {
          ctrl = {};
      }
      if (!ctrl.tags) {
          ctrl.tags = {};
      }
      if (!ctrl.tags[m[2]]) {
          ctrl.tags[m[2]] = {};
          ctrl.tags[m[2]].value = "UNDF";

      }
  }

  tagCache[tag] = {ctrl:m[1],value:ctrl.tags[m[2]]};
  cb(null, tagCache[tag]);
}
 
 /**
  * Load tag alias (.txt) files 
  * @param {fs.ReadStream} input File input stream.
  * @param {function} func Calls back with (line: string, done?: boolean)
  */
function readLines(input, func) {
  var remaining = '';

  input.on('data', (data) => {
    remaining += data;
    var index = remaining.indexOf('\n');
    var last  = 0;
    while (index > -1) {
      var line = remaining.substring(last, index);
      last = index + 1;
      func(line);
      index = remaining.indexOf('\n', last);
    }
    remaining = remaining.substring(last);
  });

  input.on('end', () => {
    func(remaining, true);
  });
}
