#!/usr/bin/env node
/**
 * Fukurō [フクロウ] - Owl (jap.) symbol of the TV version of the game.
 *
 * Control panel for the russian intellectual game Cho? Gde? Kogda?
 * more info: http://en.wikipedia.org/wiki/What%3F_Where%3F_When%3F
 *
 * (c) 2012 Alex Indigo <iam@alexindigo.com>
 * Fukurō may be freely distributed under the MIT license.
 *
 * sms_gate.js: gateway to sms service (receive/send)
 */
var http        = require('http')
  , https       = require('https')
  // handler function defined down below
  , app         = http.createServer(handler)
  , qs          = require('querystring')
  // third-party
  , io          = require('socket.io').listen(app)
  , redis       = require('redis')

  // globals
  , cache       =
    {
      players   : {},
      nameRef   : {}
    }

  // globals are bad
  , master      = null
  , db          = null

  // queue for when offline
  , masterQueue = []
  , dbQueue     = []

  // game's state
  , state       = {ready: true, hrtime: 0, number: 0}

  // settings
  , config      =
    {
      prefix    : 'fukuro',
      host      : null,
      port      : 8037
    }
  ;

// process config settings
config.host    = process.env.host || config.host;
config.port    = process.env.port || config.port;

// get twilio settings
config.account = process.env.twilio_account;
config.key     = process.env.twilio_key;
config.phone   = process.env.twilio_phone;

// get redis settings
config.redis_port = process.env.redis_port;
config.redis_host = process.env.redis_host;
config.redis_pass = process.env.redis_pass;


// check settings
if (!config.account || !config.key || !config.phone)
{
  fatalError(1, 'Please provide twillio settings.');
}
if (!config.redis_port || !config.redis_host || !config.redis_pass)
{
  fatalError(1, 'Please provide redis settings.');
}

// clean up before exit
process.on('exit', function()
{
  console.log('bye-bye');
  db.quit();
});


function main()
{
  // connect to db
  dbConnect();

  // start server
  start();
}

function dbConnect()
{
  // prepare db
  db = redis.createClient(config.redis_port, config.redis_host);

  // login
  db.auth(config.redis_pass, function()
  {
    fetchData(db);

    processQueue(db, dbQueue);
  });
}


// goes thru queue and executes it
function processQueue(instance, queue)
{
  setTimeout(function()
  {
    var record;

    if (record = queue.shift())
    {
      if (typeof record == 'function')
      {
        record(instance);
      }

      processQueue(instance, queue);
    }
  }, 0);
}

// start server
function start()
{
  // socket io config
  io.set('log level', 1);
  io.set('transports', ['websocket']);
  io.set('heartbeat interval', 20);
  io.set('heartbeat timeout', 60);

  // init server
  io.sockets.on('connection', function(socket)
  {
    // {{{ disconnect
    socket.on('disconnect', function()
    {
      master = null;
      console.log(['left', socket.id, (new Date()).toUTCString()]);
    });
    // }}}

    // {{{ handshake
    socket.on('helo', function(data, fn)
    {
      // store link to master
      master = socket;
      console.log(['joined', socket.id, (new Date()).toUTCString()]);

      fn(cache.players);

      state.ready  = data.ready;
      state.number = data.number;
      state.hrtime = process.hrtime();

      // check if something waits us here
      processQueue(master, masterQueue);
    });
    // }}}

    // state change
    socket.on('state', function(data)
    {
      state.ready  = data.ready;
      state.number = data.number;
      state.hrtime = process.hrtime();
    });
  });

  // start listening
  app.listen(config.port, config.host);
  console.log('running webserver on port '+ config.host+':'+config.port);
}


// {{{ http requests handler
function handler(req, res)
{
  var body = ''
    ;

  if (req.method == 'POST')
  {
    req.on('data', function(data)
    {
      body = body + data.toString('utf8');
    });

    req.on('end', function()
    {
      var data = qs.parse(body)
        , match
        ;

      res.end();

      if (!data || !data.Body) return;

      if (data.AccountSid == config.account)
      {
        // strip tags
        data.Body = data.Body.replace(/<[^>]*>/g, '');

        // get name
        if (cache.players[data.From])
        {
          // {{{ get team
          if (match = data.Body.match(/^team\s+(.+)\s*$/i))
          {
            // check name
            // TODO: Make it less hardcode
            if (!match[1] || match[1].length < 4)
            {
              sendMessage(data.From, 'Please provide full team name.');
              return;
            }

            // add player
            addTeam(data.From, match[1], function(err, team)
            {
              if (err) return sendMessage(data.From, err);

              if (team) sendMessage(data.From, 'Your favorite team is "'+team+'".');

              // otherwise do nothing
            });
          }
          // }}}
          else
          {
            // add answer
            addAnswer(data.From, data.Body, function(err)
            {
              if (err)
              {
                sendMessage(data.From, err);
              }
            });
          }
        }
        else if (match = data.Body.match(/^play\s+(.+)\s*$/i))
        {
          // check name
          if (!match[1] || match[1].length < 4)
          {
            sendMessage(data.From, 'Please enter at least 4 characters for your name.');
            return;
          }

          // add player
          addPlayer(data.From, match[1], function(err)
          {
            if (err)
            {
              sendMessage(data.From, err);
            }
          });

        }
        else
        {
          sendMessage(data.From, 'Please register your name by sending "play Your Name".');
        }
      }
    });
  }
  else
  {
    res.end('what?');
  }

}
// }}}

// add answer
function addAnswer(number, answer, callback)
{
  var time;

  // check if name exists
  if (!cache.players[number])
  {
    callback('Please register your name by sending "play Your Name".');
    return;
  }

  // check if it's good timing
  if (!state.ready || !state.number)
  {
    // do not notify
    // TODO: refactor it
    callback(null);
    return;
  }

  // check if it's first time
  if (state.number in cache.players[number].played)
  {
    // do not notify
    // TODO: refactor it
    callback(null);
    return;
  }

  time = process.hrtime(state.hrtime);

  // save the answer
  cache.players[number].played[state.number] =
  {
    number: state.number,
    time: time[0] * 1e9 + time[1],
    answer: answer
  };

  sendToMaster('player:answer',
  {
    id: cache.players[number].id,
    name: cache.players[number].name,
    data: cache.players[number].played[state.number]
  });

  dbStore('players:'+number, cache.players[number]);

  callback(null);
}

// add new player
function addPlayer(number, name, callback)
{
  // check if name exists
  if (cache.nameRef[name])
  {
    callback('Please choose different name, "'+name+'" already taken.');
    return;
  }

  cache.players[number] =
  {
    id: number,
    name: name,
    played: {}
  };
  // keep reference by name
  cache.nameRef[name] = number;

  sendToMaster('player:new', cache.players[number]);

  dbStore('players:'+number, cache.players[number]);
  dbStore('nameRef:'+name, cache.nameRef[name]);

  console.log(['+ new player', name, number]);

  callback(null);
}

// add favorite team
function addTeam(number, team, callback)
{
  // check if name exists
  if (!cache.players[number])
  {
    callback('Please register your name by sending "play Your Name".');
    return;
  }

  // check the team
  sendToMaster('player:team',
  {
    id: cache.players[number].id,
    team: team
  }, function(err, data)
  {
    if (err)
    {
      switch (err)
      {

        case 204:
          callback(null); // nothing to report
          break;

        case 400:
          callback('Unable to register provided team "'+team+'".');
          break;

        case 404:
          callback('Unable to find requested team "'+team+'".');
          break;

        default:
          callback(null); // it's an error, but there is not much to say
          console.log(['Unrecognized error', err, data, team, number, cache.players[number]]);
      }

      return;
    }

    // save the team
    cache.players[number].team = data.team;

    dbStore('players:'+number, cache.players[number]);

    callback(null, data.name);
  });
}

// sends (or queues) events to master
function sendToMaster(event, data, callback)
{
  // notify master
  if (master)
  {
    master.emit(event, data, callback);
  }
  else
  {
    masterQueue.push(function(master)
    {
      master.emit(event, data, callback);
    });
  }
}

// db setter
function dbStore(key, data)
{
  if (db)
  {
    dbPrepare(db, key, data);
  }
  else
  {
    dbQueue.push(function(db)
    {
      dbPrepare(db, key, data);
    });
  }
}

// db prepare
function dbPrepare(db, key, data)
{
  var str;
  try
  {
    str = JSON.stringify(data);
  }
  catch (e)
  {
    console.log(['Could not stringify', key, data, e]);
    return false;
  }

  db.set(config.prefix+':'+key, str);

  return true;
}

// db getter
function fetchData(db)
{
  db.keys(config.prefix+':*', function(err, keys)
  {
    if (err) return fatalError(err, 'Could not get keys from db');

console.log(['db keys.length', err, keys.length]);

    keys.forEach(function(key, i)
    {
      var chunks = key.split(':');

      if (typeof cache[chunks[1]] != 'undefined')
      {
        db.get(key, function(err, reply)
        {
          var data;
          try
          {
            data = JSON.parse(reply);
          }
          catch (e)
          {
            console.log(['Could not parse json: ['+key+'] ', reply]);
            return;
          }

          // put it back
          cache[chunks[1]][chunks[2]] = data;
        });
      }
    });
  });
}

// sending messages back
function sendMessage(number, message)
{
  var request
    , params
    , options
    ;

  console.log(['- sending...', number, message]);

  params = qs.stringify(
  {
    From: config.phone,
    To  : number,
    Body: message
  });

  options =
  {
    host   : 'api.twilio.com',
    port   : 443,
    path   : '/2010-04-01/Accounts/'+config.account+'/SMS/Messages.json',
    auth   : config.account+':'+config.key,
    method : 'POST',
    headers:
    {
      'Content-type'  : 'application/x-www-form-urlencoded',
      'Content-length': params.length
    }
  };

  request = https.request(options, function(res)
  {
    console.log('STATUS: ' + res.statusCode);
    console.log('HEADERS: ' + JSON.stringify(res.headers));
    res.setEncoding('utf8');
    res.on('data', function (chunk)
    {
      console.log('BODY: ' + chunk);
    });
  });

  request.on('error', function(err)
  {
    console.log('problem with request: ' + err.message);
  });

  // write data to request body
  request.write(params);
  request.end();
}

// run the thing
main();



// {{{ Santa's little helpers

function fatalError(err, message)
{
  console.log(message || 'Fatal Error.', err);
  process.exit(1);
}

