/* eslint-disable */
/**
 * 网络钩子：通过 CDP 的 Page.addScriptToEvaluateOnNewDocument 在「文档创建时、页面脚本执行前」
 * 注入主世界，从而捕获 SPA 站点的 JSON 接口数据（IMA 目录、知乎回答、小红书笔记等）。
 * 采集结果挂在 window.__TND_API__，由提取脚本读取。
 */
(function () {
  try {
    if (window.__TND_HOOKED__) return;
    window.__TND_HOOKED__ = true;
    window.__TND_API__ = [];

    var MAX_ITEMS = 80;
    var MAX_BODY = 300000;

    function push(url, body) {
      try {
        if (!body) return;
        if (window.__TND_API__.length >= MAX_ITEMS) return;
        var text = typeof body === 'string' ? body : JSON.stringify(body);
        if (!text || text.length > MAX_BODY) return;
        var trimmed = text.trim();
        if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
        window.__TND_API__.push({ url: String(url || ''), body: trimmed, at: Date.now() });
      } catch (e) { /* ignore */ }
    }

    var nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function () {
        var args = arguments;
        var url = '';
        try {
          url = (args[0] && args[0].url) ? args[0].url : String(args[0]);
        } catch (e) { /* ignore */ }
        var p = nativeFetch.apply(this, args);
        try {
          p.then(function (res) {
            try {
              var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
              if (/json|text\/plain/i.test(ct) && typeof res.clone === 'function') {
                res.clone().text().then(function (t) { push(res.url || url, t); }).catch(function () {});
              }
            } catch (e) { /* ignore */ }
          }).catch(function () {});
        } catch (e) { /* ignore */ }
        return p;
      };
    }

    var XO = XMLHttpRequest.prototype.open;
    var XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      try { this.__tnd_url = u; } catch (e) { /* ignore */ }
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      try {
        self.addEventListener('load', function () {
          try {
            var ct = self.getResponseHeader('content-type') || '';
            var body = null;
            if (/json/i.test(ct)) {
              body = (self.responseType === '' || self.responseType === 'text') ? self.responseText : JSON.stringify(self.response);
            }
            if (body) push(self.__tnd_url || self.responseURL, body);
          } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
      return XS.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }
})();
