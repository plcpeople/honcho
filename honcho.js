/*!
 * Honcho
 *
 * Multiple PLC Manager
 * 
 */

/**
 * Module dependencies
 */
var crypto = require('crypto')
  , fs = require('fs')
  , util = require('util')
  , path = require('path')
;

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

exports.configure = function(config, cb){

  console.log('configuring ' + config.controllers.length +' controllers');

  tagFileDir = config.tagFileDir;

  function done(){
    // map default controller
    controllers['default'] = controllers[config.defaultController];
    cb();
  }

  var ctrls = config.controllers.slice();  
  function next(ctrl){
    if(ctrl){
      controllers[ctrl.connection_name] = new Controller(ctrl, function(){
        next(ctrls.shift());
      });
    }else{
      done(null);
      return;
    }
  }
  next(ctrls.shift());
}

function bounce(n){return n;}


function Controller(conf, cb){
  var self = this
    , tagfile
    , cparams;

  var Conn = require(conf.type);
  self.conn = new Conn();
  self.conn.setTranslationCB(bounce);
  cparams = conf;  // Passing the entire object, not just port and host, allows protocol-specific options

  // bind controller functions to Connection
  ['addItems','removeItems', 'readAllItems', 'findItem', 'writeItems'].forEach(function(method){
    self[method] = self.conn[method].bind(self.conn);
  });
  
  //console.log(self);

  tagfile = path.join(tagFileDir, conf.tagfile);
  
  if(tagFileLookCache[tagfile]){
    //console.log('Loading Shared Tags '+tagfile);
    self.tags = tagFileLookCache[tagfile]; 
    self.conn.initiateConnection(cparams, cb);
  }else{
    var l,m, input;
    self.tags = {};
    input = fs.createReadStream(tagfile);
    readLines(input, function(data, done){
      l = data.toString().replace(/\s/g,'');
      m = l.match(/^([A-Z|a-z|0-1|_].+)=(.+)$/);
      if(m){
        self.tags[m[1]]=m[2];
      }
      if(done){
        tagFileLookCache[tagfile] = self.tags;
        self.conn.initiateConnection(cparams, cb);
      }
    });
  }
}

Controller.prototype.simulateSlowReadAllItems = function(cb){
  var self = this;
  setTimeout(function(){
    self.readAllItems(cb);
  }, 500);
}

Controller.prototype.createPoll = function(packet,  cb, timeout){
  var self = this
    , values = packet.values
    , tags = packet.tags
    , tick;

  self.addItems(values);

  function poll(){
    tick = Date.now();
    // toggle this to simulate slow results
    //self.simulateSlowReadAllItems(
    self.readAllItems(
      function(){
      var results = {}, value;
      for(var i=0;i<values.length;i++){
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
      self.pollId = setTimeout(poll,diff);
    });
  }
  poll();
}

Controller.prototype.clearPoll = function(){
  var self = this;
  clearTimeout(self.pollId);
}

exports.findItem = function(tags, cb){
  tags = [].concat(tags);
  generateControllerPackets(tags, function(err, controllerPackets){
    if(err){
      console.log(err);
    }
    findPackets(controllerPackets, cb);
  });
}

exports.read = function(tags, cb){
  // register tags for lookup against controller
  if(typeof tags !== 'string' && toString.call(tags) !== '[object Array]'){
    cb(new Error('@tags must to be a String or an Array'));
    return;
  }
  // clone tags
  tags = [].concat(tags);
  generateControllerPackets(tags, function(err, controllerPackets){
    if(err){
      console.log("ERROR:", err);
    }
    //console.log('controllerPackets', controllerPackets);
    readPackets(controllerPackets, cb);
  });
}
  
exports.write = function(tag, value, cb){
  tagLookup(tag, function(err, tagObj) {
    if(!err) {    
      // TODO: improve security
//      if (tagObj.ctrl && controllers[tagObj.ctrl].cparams.allowWrite) {
        console.log('Writing value ' + value + ' to '+ util.format(tagObj));
        controllers[tagObj.ctrl].writeItems(tagObj.value, value);
//      } else {
//        console.log('Not writing value ' + value + ' to '+ util.format(tagObj) + ' due to error (no allowWrite?)!!!');    
//      }
    }
//    process.exit();
  });
}

exports.createSubscription = function(tags, cb, timeout){

  if(typeof timeout === 'undefined'){
    timeout = 0;
  }
  
  token = crypto.createHash('md5').update(String(tags)).digest('hex');
  if(subscriptions[token]){
    return;
  }

  generateControllerPackets(tags, function(err, controllerPackets){
    subscriptions[token] = {
      ts:Date.now(),
      controllerPackets: controllerPackets
    }

    if(err){
      console.log(err);
    }
    Object.keys(controllerPackets).forEach(function(key) {
      controllers[key].createPoll(controllerPackets[key], cb, timeout);
    }); 
  });

  return token; 
}

exports.removeSubscription = function(token){
  var controllerPacketSubscription = subscriptions[token];
  if(typeof controllerPacketSubscription === 'undefined'){
    throw new Error('A valid token must be supplied to remove a subscription');
  }
  Object.keys(controllerPacketSubscription.controllerPackets).forEach(function(key) {
    controllers[key].clearPoll();
  }); 
}

/**
 * Get Tags
 */

exports.browse = function(parent, cb){
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
 * INTERNAL functions
 */

/**
 *
 */

function findPackets(controllerPackets, cb){
  Object.keys(controllerPackets).forEach(function(key) {
    var values = controllerPackets[key];
    //console.log(values);
    controllers[key].findItem(values,cb);
  }); 
}

/**
 * Sends all tags to a controllers
 */
// FIXME: tmp solution
var XXX_CACHE = {};

function readPackets(controllerPackets,cb){
  // should we wait for everyone
  // could add a for wait
  Object.keys(controllerPackets).forEach(function(key) {
    var values = controllerPackets[key].values;
    var tags = controllerPackets[key].tags;

    //console.log('TAGS:',tags);

    var shasum = crypto.createHash('sha1');
    shasum.update(String(values));
    var token = shasum.digest('hex');

    if(!XXX_CACHE[token]){
      XXX_CACHE[token] = values;
      controllers[key].addItems(values);
    }

    controllers[key].readAllItems(
      function(){
        var results = {}, value;
        for(var i=0;i<values.length;i++){
          value = controllers[key].findItem(values[i]);
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
        //setTimeout(cb,1000, null, results);
        //cb(null, results);
      });
  }); 
}

/**
 * Generates an array of tags assocaited to a controller
 */

function generateControllerPackets(tags, cb){
  var controllerPackets = {};
  function next(tag) {
    if(tag) {
      tagLookup(tag, function(err, packet){
        if(err){
          console.log(err);
        }else{
          var p = controllerPackets[packet.ctrl] || {};
          p.values = p.values || [];
          p.values.push(packet.value);
          p.tags = p.tags || [];
          p.tags.push(tag);
          controllerPackets[packet.ctrl] = p;
        }
        return next(tags.shift());
      });
    } else {
      cb(null,controllerPackets);
    }
  }
  next(tags.shift());
}

/**
 * Tag lookup
 */

function tagLookup(tag, cb){
  var ctrl,packet,m,t;

  packet = tagCache[tag];
  if(packet){
    //console.log(tag,'from cache');
    cb(null, packet);
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
  if(!m){
    cb(new Error("INVALID TAG FORMAT"));
    return;
  }

  //
  ctrl = controllers[m[1]];
  if(typeof ctrl === 'undefined' || typeof ctrl.tags[m[2]] === 'undefined'){
    cb(new Error('INVALID TAG'));
    return;
  } 
  
  tagCache[tag] = {ctrl:m[1],value:ctrl.tags[m[2]]};
  cb(null, tagCache[tag]);
}

/*
 * Load Tagfiles
 */

function readLines(input, func) {
  var remaining = '';

  input.on('data', function(data) {
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

  input.on('end', function() {
    func(remaining, true);
  });
}

