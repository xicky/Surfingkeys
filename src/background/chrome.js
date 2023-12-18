import {
    LOG,
    filterByTitleOrUrl,
} from '../content_scripts/common/utils.js';
import {
    _save,
    dictFromArray,
    extendObject,
    getSubSettings,
    start
} from './start.js';

function loadRawSettings(keys, cb, defaultSet) {
    var rawSet = defaultSet || {};
    chrome.storage.local.get(null, function(localSet) {
        var localSavedAt = localSet.savedAt || 0;
        chrome.storage.sync.get(null, function(syncSet) {
            var syncSavedAt = syncSet.savedAt || 0;
            if (localSavedAt > syncSavedAt) {
                extendObject(rawSet, localSet);
                _save(chrome.storage.sync, localSet, function() {
                    var subset = getSubSettings(rawSet, keys);
                    if (chrome.runtime.lastError) {
                        subset.error = "Settings sync may not work thoroughly because of: " + chrome.runtime.lastError.message;
                    }
                    cb(subset);
                });
            } else if (localSavedAt < syncSavedAt) {
                extendObject(rawSet, syncSet);
                cb(getSubSettings(rawSet, keys));
                _save(chrome.storage.local, syncSet);
            } else {
                extendObject(rawSet, localSet);
                cb(getSubSettings(rawSet, keys));
            }
        });
    });
}

function _applyProxySettings(proxyConf) {
    if (!proxyConf.proxyMode || proxyConf.proxyMode === 'clear') {
        chrome.proxy.settings.clear({scope: 'regular'});
    } else {
        var autoproxy_pattern = proxyConf.autoproxy_hosts.map(function(h) {
            return h.filter(function(a) {
                return a.indexOf('*') !== -1;
            }).join('|');
        });
        var autoproxy_hosts = proxyConf.autoproxy_hosts.map(function(h) {
            return dictFromArray(h.filter(function(a) {
                return a.indexOf('*') === -1;
            }), 1);
        });
        var config = {
            mode: (["always", "byhost", "bypass"].indexOf(proxyConf.proxyMode) !== -1) ? "pac_script" : proxyConf.proxyMode,
            pacScript: {
                data: `var pacGlobal = {
                        hosts: ${JSON.stringify(autoproxy_hosts)},
                        autoproxy_pattern: ${JSON.stringify(autoproxy_pattern)},
                        proxyMode: '${proxyConf.proxyMode}',
                        proxy: ${JSON.stringify(proxyConf.proxy)}
                    };
                    function FindProxyForURL(url, host) {
                        var lastPos;
                        if (pacGlobal.proxyMode === "always") {
                            return pacGlobal.proxy[0];
                        } else if (pacGlobal.proxyMode === "bypass") {
                            var pp = new RegExp(pacGlobal.autoproxy_pattern[0]);
                            do {
                                if (pacGlobal.hosts[0].hasOwnProperty(host)
                                    || (pacGlobal.autoproxy_pattern[0].length && pp.test(host))) {
                                    return "DIRECT";
                                }
                                lastPos = host.indexOf('.') + 1;
                                host = host.slice(lastPos);
                            } while (lastPos >= 1);
                            return pacGlobal.proxy[0];
                        } else {
                            for (var i = 0; i < pacGlobal.proxy.length; i++) {
                                var pp = new RegExp(pacGlobal.autoproxy_pattern[i]);
                                var ahost = host;
                                do {
                                    if (pacGlobal.hosts[i].hasOwnProperty(ahost)
                                        || (pacGlobal.autoproxy_pattern[i].length && pp.test(ahost))) {
                                        return pacGlobal.proxy[i];
                                    }
                                    lastPos = ahost.indexOf('.') + 1;
                                    ahost = ahost.slice(lastPos);
                                } while (lastPos >= 1);
                            }
                            return "DIRECT";
                        }
                    }`
            }
        };
        chrome.proxy.settings.set( {value: config, scope: 'regular'}, function() {
        });
    }
}

function _setNewTabUrl(){
    return  "chrome://newtab/";
}

function _getContainerName(self, _response){
}

const HistoryCache = {
    size: 20000,
    // an array of History items returned from Chrome
    history: null,

    reset() {
        this.history = null;
        chrome.history.onVisited.removeListener(this._onVisitedListener);
        chrome.history.onVisitRemoved.removeListener(this._onVisitRemovedListener);
    },

    async onLoaded() {
        if (this.history) return;
        await this.fetchHistory();
    },

    async fetchHistory() {
        if (this.chromeHistoryPromise) {
            await this.chromeHistoryPromise;
            return;
        }

        this.chromeHistoryPromise = new Promise((resolve, reject) => {
            chrome.history.search({
                text: "",
                maxResults: this.size,
                startTime: 0,
            }, function (items) {
                resolve(items);
            });
        });

        const history = await this.chromeHistoryPromise;
        history.sort(this.compareHistoryByUrl);
        this.history = history;
        chrome.history.onVisited.addListener(this._onVisitedListener);
        chrome.history.onVisitRemoved.addListener(this._onVisitRemovedListener);
        this.chromeHistoryPromise = null;
    },

    compareHistoryByUrl(a, b) {
        if (a.url === b.url) return 0;
        if (a.url > b.url) return 1;
        return -1;
    },

    onVisited(newPage) {
        if (newPage.title == null) newPage.title = "";
        const i = HistoryCache.binarySearch(newPage, this.history, this.compareHistoryByUrl);
        const pageWasFound = this.history[i]?.url === newPage.url;
        if (pageWasFound) {
            this.history[i] = newPage;
        } else {
            this.history.splice(i, 0, newPage);
        }
    },

    onVisitRemoved(toRemove) {
        if (toRemove.allHistory) {
            this.history = [];
            return;
        }

        toRemove.urls.forEach((url) => {
            const i = HistoryCache.binarySearch({ url }, this.history, this.compareHistoryByUrl);
            if ((i < this.history.length) && (this.history[i].url === url)) {
                this.history.splice(i, 1);
            }
        });
    },
};

HistoryCache._onVisitedListener = HistoryCache.onVisited.bind(HistoryCache);
HistoryCache._onVisitRemovedListener = HistoryCache.onVisitRemoved.bind(HistoryCache);

HistoryCache.binarySearch = (target, array, compareFun) => {
    let element, middle;
    let high = array.length - 1;
    let low = 0;

    while (low <= high) {
        middle = Math.floor((low + high) / 2);
        element = array[middle];
        const compareResult = compareFun(element, target);
        if (compareResult > 0) {
            high = middle - 1;
        } else if (compareResult < 0) {
            low = middle + 1;
        } else {
            return middle;
        }
    }

    if (compareFun(element, target) < 0) {
        return middle + 1;
    }
    return middle;
}

function getLatestHistoryItem(text, maxResults, cb) {
    HistoryCache.onLoaded().then(() => {
        const filtered = filterByTitleOrUrl(HistoryCache.history, text);
        cb(filtered.slice(0, maxResults));
    });
}

function generatePassword() {
    const random = new Uint32Array(8);
    window.crypto.getRandomValues(random);
    return Array.from(random).join("");
}

let nativeConnected = false;
const nvimServer = {};
function startNative() {
    return new Promise((resolve, reject) => {
        const nm = chrome.runtime.connectNative("surfingkeys");
        const password = generatePassword();
        nm.onDisconnect.addListener((evt) => {
            if (chrome.runtime.lastError) {
                var error = chrome.runtime.lastError.message;
            }
            if (nativeConnected) {
                nvimServer.instance = startNative();
            } else {
                LOG("error", "Failed to connect neovim, please make sure your neovim version 0.5 or above.");
            }
        });
        nm.onMessage.addListener(async (resp) => {
            if (resp.status === true) {
                nativeConnected = true;
                if (resp.res.event === "serverStarted") {
                    const url = `127.0.0.1:${resp.res.port}/${password}`;
                    resolve({url, nm});
                }
            } else if (resp.err) {
                LOG("error", resp.err);
            }
        });
        nm.postMessage({
            startServer: true,
            password
        });
    });
}
nvimServer.instance = startNative();

start({
    detectTabTitleChange: true,
    getLatestHistoryItem,
    loadRawSettings,
    nvimServer,
    _applyProxySettings,
    _setNewTabUrl,
    _getContainerName
});
