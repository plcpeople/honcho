honcho
======

Honcho is a multiple PLC connection manager for Node.JS using nodes7/nodepccc/mcprotocol or other libraries that use a similar API to those.

Normally Honcho will be called by a program that configures it and subscribes to its polls, like a server that streams PLC data over a Websocket or TCP stream.

Honcho is initially configured by a configuration object and multiple PLC tag files.

First create a tag to address translation file using a text editor:

testplctags.txt should have only one line for the following example to work:
	MYTAG=DB99,INT0

Example application:

	var honcho = require('honcho');

	config = {
		defaultController: 'TESTPLC',
		tagFileDir: '.',
		controllers: [
			{ host: '192.168.1.2',
			connection_name: 'TESTPLC',
			port: 102,
			slot: 1, 	/* See NodeS7 docs - slot 1 for 1200/1500, slot 2 for 300 */
			type: 'nodes7',
      			tagfile: './testplctags.txt' }
  			],

  		/* Define one or more tagsets to be subscribed to */
		tagsets: ['status'],

  		/* Define one or more tags to be subscribed to */
		tags : {
			'MYTAG':{
			tagsets:['status']
			}		
		}
	};

	function readDone(err, vars) {
		console.log(vars);
		// Or stream to a Websocket, etc
	}

	honcho.configure(config, function(){
		honcho.createSubscription(['MYTAG'], readDone, 500);
	});

This will log the following every 500ms:

	{ MYTAG: 0 }



### API
 - [configure()](#configure)
 - [findItem()](#findItem)
 - [read()](#read)
 - [write()](#write)
 - [createSubscription()](#createSubscription)
 - [removeSubscription()](#removeSubscription)

#### <a name="configure"></a>honcho.configure(config, callback)
Sets up the configuration and calls the callback when done.  Please see above for configuration syntax.

#### <a name="findItem"></a>honcho.findItem(item, callback)
Retuns the full "item" from the PLC driver in the callback.

#### <a name="read"></a>honcho.read(tags, callback)
Reads specific tags and runs a callback with their values.  Note the callback is called as callback(err, values).

#### <a name="write"></a>honcho.write(tag, value, callback)
Writes a specific tag and runs an optional callback with the result.

#### <a name="createSubscription"></a>honcho.createSubscription(tag array, callback, interval)
Sets up a subscription that will return the values of listed tags every timeout via the callback.  Returns a token useful for removing subscriptions.  Note the callback is called as callback(err, values).

#### <a name="removeSubscription"></a>honcho.removeSubscription(token)
Removes a subscription using a token returned when creating it.

