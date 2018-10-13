/**
 * @module vue-wamp/plugin
 * @license MIT
 * @author Lajos Bencz <lazos@lazos.me>
 * @see https://github.com/lajosbencz/vue-wamp
 */

import ab from 'autobahn-browser';
import defer from 'deferred';

/* static */
var _lost = false,
    _connection = null,
    _session = null,
    _queue = [],
    _collect = [],
    _defaultOptions = {},
    _debug = false;

function _log(args) {
    if (_debug) {
        console.debug.apply(console, arguments);
    }
}

function _kebab(string) {
    return string.replace(/[A-Z\u00C0-\u00D6\u00D8-\u00DE]/g, function (match) {
        return '-' + match.toLowerCase();
    });
}

function _key(context) {
    var key = _kebab(context.constructor.name) + '-' + context._uid;
    if (key.substring(0, 3) === 'vm-') key = key.substring(3);
    return key;
}

function _open() {
    if (!_connection) {
        _specialConnect();
    }
    if (_connection && !_connection.isConnected) {
        _connection.open();
    } else {}
    return true;
}

function _close(reason, message) {
    if (_connection && _connection.isOpen) {
        _detach(null);
        _connection.close(reason, message);
    }
}

function _reconnect() {
    _close('wamp.goodbye.reconnect');
    _lost = true;
    _open();
}

function _opened() {
    var i = void 0;
    for (var q in _queue) {
        if (_queue.hasOwnProperty(q)) {
            i = _queue[q];
            _relay(i).then(i.defer.resolve, i.defer.reject, i.defer.notify);
            if (!i.persist) {
                delete _queue[q];
            }
        }
    }

    if (_lost) {
        _log('$wamp::opened re-established connection after lost');
    } else {
        _log('$wamp::opened handling backlog');
    }
    _lost = false;
}

function _closed() {
    _session = null;
    _queue = [];
    _collect = [];
}

function _defer(context, type, name, callback, args, kwArgs, options) {
    _open();
    if (!options) {
        options = {};
    }
    options.acknowledge = true;
    var i = { context: context, type: type, name: name, callback: callback, args: args, kwArgs: kwArgs, options: options };
    if (i.callback && i.context) {
        i.callback = i.callback.bind(i.context);
    }
    i.persist = options && options.persist;
    if (!_session) {
        i.defer = defer();
        _queue.push(i);
        return i.defer.promise;
    }
    return _relay(i);
}

function _relay(i) {
    if (i.type.substr(0, 2) === 'un') {
        return _session[i.type](i.name);
    } else if (i.type === 'subscribe' || i.type === 'register') {
        var d = defer();
        _session[i.type](i.name, i.callback, i.options).then(function (r) {
            if (i.context !== null) {
                var k = _key(i.context);
                if (!_collect.hasOwnProperty(k)) {
                    _collect[k] = [];
                }
                _collect[k].push({
                    name: i.name,
                    type: i.type,
                    context: i.context,
                    instance: r
                });
            }
            d.resolve(r);
        }, d.reject);
        return d.promise;
    } else {
        return _session[i.type](i.name, i.args, i.kwArgs, i.options);
    }
}

function _detachItem(item) {
    if (item.type === 'subscribe' || item.type === 'register') {
        var t = 'un' + item.type;
        _log('Vue WAMP auto ' + t, item);
        _session[t](item.instance);
    }
}

function _detach(context) {
    if (_connection && _connection.isConnected) {
        if (context === null) {
            var c = void 0;
            while (c = _collect.shift()) {
                var q = void 0;
                while (q = c.shift()) {
                    _detachItem(q);
                }
            }
        } else {
            var k = _key(context);
            if (_collect.hasOwnProperty(k)) {
                var _q = void 0;
                while (_q = _collect[k].shift()) {
                    _detachItem(_q);
                }
            }
        }
    }
}

function _specialConnect(options) {
    if (_connection && _connection.isConnected) {
        return true;
    }

    options = Object.assign({ debug: false, lazy_open: true }, _defaultOptions, options);

    _debug = options.debug;

    _connection = new ab.Connection(options);

    _connection.onopen = function (session, details) {
        _session = session;
        if (options.hasOwnProperty('onopen') && typeof options['onopen'] === 'function') {
            options.onopen.apply(_connection, [session, details]);
        }
        _opened();
    };

    _connection.onclose = function (reason, details) {
        _lost = reason === 'lost';
        if (options.hasOwnProperty('onclose') && typeof options['onclose'] === 'function') {
            options.onclose.apply(_connection, [reason, details]);
        }
        _closed();
    };

    if (!options.lazy_open) {
        _open();
    }

    return true;
}

function plugin(Vue, options) {
    _defaultOptions = Object.assign({ debug: false, lazy_open: true }, options);

    _debug = options.debug;

    Object.defineProperties(Vue.prototype, {
        $wamp: {
            get: function get() {
                var self = this;
                return {
                    isConnected: function isConnected() {
                        return _connection && _connection.isConnected;
                    },
                    isOpen: function isOpen() {
                        return _connection && _connection.isOpen;
                    },
                    isRetrying: function isRetrying() {
                        return _connection && _connection.isRetrying;
                    },

                    open: _open,
                    close: _close,
                    reconnect: _reconnect,
                    subscribe: function subscribe(topic, handler, options) {
                        _log('$wamp.subscribe', topic, options);
                        _specialConnect(options);
                        return _defer(self, 'subscribe', topic, handler, null, null, options);
                    },
                    publish: function publish(topic, args, kwargs, options) {
                        _log('$wamp.publish', topic, args, kwargs, options);
                        _specialConnect(options);
                        return _defer(self, 'publish', topic, null, args, kwargs, options);
                    },
                    call: function call(procedure, args, kwargs, options) {
                        _log('$wamp.call', procedure, args, kwargs, options);
                        _specialConnect(options);
                        return _defer(self, 'call', procedure, null, args, kwargs, options);
                    },
                    register: function register(procedure, endpoint, options) {
                        _log('$wamp.register', procedure, options);
                        _specialConnect(options);
                        return _defer(self, 'register', procedure, endpoint, null, null, options);
                    },
                    unsubscribe: function unsubscribe(topic) {
                        _log('$wamp.unsubscribe', topic, options);
                        _specialConnect(options);
                        return _defer(self, 'unsubscribe', topic, null, null, null, null);
                    },
                    unregister: function unregister(procedure) {
                        _log('$wamp.unregister', procedure, options);
                        _specialConnect(options);
                        return _defer(self, 'unregister', procedure, null, null, null, null);
                    }
                };
            }
        }
    });

    Vue.Wamp = {
        open: _open,
        close: _close,
        reconnect: _reconnect,
        isConnected: function isConnected() {
            return _connection && _connection.isConnected;
        },
        isOpen: function isOpen() {
            return _connection && _connection.isOpen;
        },
        isRetrying: function isRetrying() {
            return _connection && _connection.isRetrying;
        },
        specialConnect: function specialConnect(options) {
            return _specialConnect(options);
        },
        subscribe: function subscribe(topic, handler, options) {
            _log('Wamp.subscribe', topic, options);
            _specialConnect(options);
            return _defer(null, 'subscribe', topic, handler, null, null, options);
        },
        publish: function publish(topic, args, kwargs, options) {
            _log('Wamp.publish', topic, args, kwargs, options);
            _specialConnect(options);
            return _defer(null, 'publish', topic, null, args, kwargs, options);
        },
        call: function call(procedure, args, kwargs, options) {
            _log('Wamp.call', procedure, args, kwargs, options);
            _specialConnect(options);
            return _defer(null, 'call', procedure, null, args, kwargs, options);
        },
        register: function register(procedure, endpoint, options) {
            _log('Wamp.register', procedure, options);
            _specialConnect(options);
            return _defer(null, 'register', procedure, endpoint, null, null, options);
        },
        unsubscribe: function unsubscribe(topic) {
            _log('Wamp.unsubscribe', topic, options);
            _specialConnect(options);
            return _defer(null, 'unsubscribe', topic, null, null, null, null);
        },
        unregister: function unregister(procedure) {
            _log('Wamp.unregister', procedure, options);
            _specialConnect(options);
            return _defer(null, 'unregister', procedure, null, null, null, null);
        }
    };
}

export default plugin;
