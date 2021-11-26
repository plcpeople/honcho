honcho
======

Honcho is a multiple PLC connection manager for Node.JS using nodes7/nodepccc/mcprotocol/mbtcpprotocol or other libraries that use a similar API to those.

Normally Honcho will be called by a program that configures it and subscribes to its polls, like a server that streams PLC data over a Websocket or TCP stream.

Honcho is initially configured by a configuration object and multiple PLC tag files.

First create a tag to address translation file using a text editor:

testplctags.txt should have only one line for the following example to work:
	MYTAG=DB99,INT0

When you specify tags you need to prefix the tag name with the PLC name and a "/" as a separator.  If you specify a default controller, (defaultController object), this will be used by default.

Example application:

	var honcho = require('honcho');

	config = {
		defaultController: 'TESTPLC',  /* This is optional, if you omit it, you must always prefix tags with the connection_name */
		tagFileDir: '.',
		controllers: [
			{ 
				host: '192.168.1.2',
				connection_name: 'TESTPLC',
				port: 102,
				slot: 1, 	/* See NodeS7 docs - slot 1 for 1200/1500, slot 2 for 300 */
				type: 'nodes7',
      			tagfile: './testplctags.txt' 
			},
			{ 
				host: '192.168.1.2',	
				connection_name: 'TESTPLC2',
				port: 102,
				slot: 1, 	/* See NodeS7 docs - slot 1 for 1200/1500, slot 2 for 300 */
				type: 'nodes7',
      			tagfile: './testplctags.txt'   /* For this example we are pointing to the same file like a second PLC running the same program */
			}
  		],

  		/* Define one or more tagsets to be subscribed to */
		tagsets: ['status'],

  		/* Define one or more tags to be subscribed to */
		tags : {
			'MYTAG':{
			tagsets:['status']
			},
			'TESTPLC2/MYTAG':{
			tagsets:['status']
			}		
		}
	};

	function readDone(err, vars) {
		console.log(vars);
		// Or stream to a Websocket, etc
	}

	honcho.configure(config, function(){
		honcho.createSubscription(['MYTAG','TESTPLC2/MYTAG'], readDone, 500);
	});

This will log the following every 500ms:

	{ MYTAG: 0 } and { 'TESTPLC/MYTAG2': 0 }



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

#### <a name="writeItems"></a>honcho.writeItems(items, callback)
Write any number of tags at once. Given an object mapping a tag name to the desired value. Tags can span multiple controllers on the network. DOES NOT fail on single controller write error unless you call done(err).

#### <a name="createSubscription"></a>honcho.createSubscription(tag array, callback, interval)
Sets up a subscription that will return the values of listed tags every timeout via the callback.  Returns a token useful for removing subscriptions.  Note the callback is called as callback(err, values).

#### <a name="removeSubscription"></a>honcho.removeSubscription(token)
Removes a subscription using a token returned when creating it.

