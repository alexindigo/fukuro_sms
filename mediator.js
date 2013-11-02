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
 * mediator.js: proxies events between main server and sms_gate
 */
var ioClient   = require('socket.io-client')

  // globals
  , state      =
    {
      ready    : false,
      number   : 0,
      timer    : -1
    }

  , players    = {}
  , questions  = {}
  , teams      = {}

  , connection =
    {
      master: null,
      smsgate: null
    }

  // settings
  , config     =
    {
      master   : '127.0.0.1:7890',
      smsgate: 'fukuro.jit.su:80',
//      smsgate  : 'amber.exposeapp.com:8037',
      password : null
    }
  ;

// process config settings
config.master   = process.env.master || config.master;
config.smsgate  = process.env.smsgate || config.smsgate;
config.password = process.env.password || config.password;

// {{{ main
function main()
{
  toMaster(function(err, master)
  {
    if (err) return fatalError(err, 'Could not connect to master');

    toSmsgate(function(err, smsgate)
    {
      if (err) return fatalError(err, 'Could not connect to smsgate');

      start(master, smsgate);
    });
  });
}
// }}}

function toMaster(callback)
{
  if (connection.master) return callback(null);

  // connect to the master
  console.log('connecting... '+ config.master);
  var master = ioClient.connect('ws://'+config.master);

  master.on('connect', function()
  {
    connection.master = master;

    console.log('connected to master ['+config.master+']');

    master.emit('helo', {me: 'admin'}, function(data)
    {
      console.log(['master: successful handshake']);

      // get current state
      if (data.current && data.current.item == 'question' && data.current.number && !(''+data.current.number).match(/^playoff /))
      {
        state.ready = true;
        state.number = data.current.number;
      }
      else
      {
        state.ready = false;
        state.number = 0;
      }

      // get keywords
      Object.keys(data.content.questions).forEach(function(n)
      {
        if ((''+n).match(/^playoff /)) return;

        questions[n] = buildRE(data.content.questions[n].answer.keyword.split(','));
      });

      // get teams
      Object.keys(data.teams).forEach(function(t)
      {
        // can't support fake team
        if (data.teams[t].collective) return;

        teams[t] =
        {
          handle: t,
          name  : data.teams[t].short,
          match : buildRE(data.teams[t].keyword.split(','))
        }
      });

      // and start the server
      callback(null, master);
    });
  });
}

function buildRE(list)
{
  var i, j, word, code, result = [];

  for (i=0; i<list.length; i++)
  {
    word = list[i].trim().split('');

    for (j=0; j<word.length; j++)
    {
      switch (code = word[j].charCodeAt())
      {
        case 32:
          word[j] = '\\s+';
          break;

        default:
          word[j] = '\\u' + padLeft((+code).toString(16), 4);
      }
    }

    result[i] = word.join('');
  }

  return new RegExp('('+result.join('|')+')', 'i');
}

function padLeft(number, length, fill)
{
  var str = ''+number;

  // defaults
  length = length || 2;
  fill   = fill || '0';

  while (str.length < length)
  {
    str = fill + str;
  }

  return str;
}

function toSmsgate(callback)
{
  if (connection.smsgate) return callback(null);

  // connect to the master
  console.log('connecting... '+ config.smsgate);
  var smsgate = ioClient.connect('ws://'+config.smsgate);

  smsgate.on('connect', function()
  {
    connection.smsgate = smsgate;

    console.log('connected to smsgate ['+config.smsgate+']');

    smsgate.emit('helo', state, function(data)
    {
      console.log(['smsgate: successful handshake']);

      // store current state
      if (data)
      {
        players = {};

        Object.keys(data).forEach(function(k)
        {
          var pl = data[k];

          players[pl.id] =
          {
            id: pl.id,
            name: pl.name,
            played: {}
          };

          if (pl.played)
          {
            Object.keys(pl.played).forEach(function(n)
            {
              var round = pl.played[n];

              if (testAnswer(round))
              {
                players[pl.id].played[round.number] = round;
              }
            });
          }
        });
      }

      // and start the server
      callback(null, smsgate);
    });
  });
}

// start server
function start(master, smsgate)
{

console.log(['connected', !!master, !!smsgate, (new Date()).toUTCString()]);

  if (master)
  {
    // hack
    master.emit('players:dump', players);

    // {{{ disconnect
    master.on('disconnect', function()
    {
      connection.master = null;
      console.log(['disconnected from master', (new Date()).toUTCString()]);
    });
    // }}}

    // listen for master emitted events
    // and defined state
    master.on('on', function(data, fn)
    {
      if (data.item == 'answer')
      {
        state.ready = false;

        // notify smsgate
        connection.smsgate.emit('state', state);
      }
      else if (data.item == 'question' && data.number && !(''+data.number).match(/^playoff /))
      {
        state.ready = true;
        state.number = data.number;

        // notify smsgate
        connection.smsgate.emit('state', state);
      }
    });

    master.on('off', function(data, fn)
    {
      if (data.item == 'answer' || data.item == 'question')
      {
        state.ready = false;
        state.number = 0;
        state.timer = -1;

        // notify smsgate
        connection.smsgate.emit('state', state);
      }
    });

    master.on('timer', function(data, fn)
    {
      state.timer = data.time;
    });
  }

  // --- listen to smsgate events

  if (smsgate)
  {
    // {{{ disconnect
    smsgate.on('disconnect', function()
    {
      connection.smsgate = null;
      console.log(['disconnected from smsgate', (new Date()).toUTCString()]);
    });
    // }}}

    // new player registred
    // TODO: combat duplicates
    smsgate.on('player:new', function(player)
    {
      // don't add more than once
      if (!player || !player.id || players[player.id]) return;

      players[player.id] =
      {
        id: player.id,
        name: player.name,
        played: {}
      };

      // notify master
      connection.master.emit('player:new', player);
    });

    // player favored the team
    smsgate.on('player:team', function(player, fn)
    {
      var t, chosen;

      // check answer
      if (!player || !player.id || !player.team || !players[player.id])
      {
        return fn(400); // missing parameters
      }

      // check for team
      for (t in teams)
      {
        if (!teams.hasOwnProperty(t)) continue;

        if (teams[t].match.test(player.team))
        {
          chosen = t;
          break;
        }
      }

      if (!chosen)
      {
        return fn(404); // no team found
      }

      // don't do anything extra
      if (players[player.id].team == chosen)
      {
        return fn(204); // nothing changed
      }

      // update player records
      players[player.id].team = chosen;

      // notify master
      connection.master.emit('player:team', {id: player.id, team: chosen});

      // confirm selection
      fn(null, {id: player.id, team: chosen, name: teams[chosen].name});
    });

    // answer received
    // TODO: combat duplicates
    smsgate.on('player:answer', function(answer)
    {
      // check answer
      if (answer && answer.data && testAnswer(answer.data))
      {
        if (!players[answer.id])
        {
          players[answer.id] =
          {
            id: answer.id,
            name: answer.name,
            played: {}
          };
        }

        if (!(answer.data.number in players[answer.id].played))
        {
          // store them locally
          players[answer.id].played[answer.data.number] = answer.data;
          // notify master
          connection.master.emit('player:answer', answer);
        }
      }
    });
  }
}

function testAnswer(obj)
{
  return (obj && questions[obj.number].test(obj.answer));
}

// run the thing
main();




// {{{ Santa's little helpers

function fatalError(err, message)
{
  console.log(message || 'Fatal Error.', err);
  process.exit(1);
}

