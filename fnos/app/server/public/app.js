/* ==========================================================================
   GStats 前端单页应用
   - 原生 JavaScript，无构建步骤、无第三方依赖
   - Hash 路由：#/ #/github #/repo/:owner/:name #/explore #/stats #/reports #/settings
   - 浏览埋点：进入项目详情即开始计时，15 秒心跳累计停留时长
   ========================================================================== */
(function () {
  "use strict";

  var PREFIX = (window.GSTATS_PREFIX || "/app/gstats").replace(/\/+$/, "");
  var API_BASE = PREFIX;
  var HEARTBEAT_MS = 15000;

  /* --------------------------------------------------------------- 基础工具 */

  function el(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function attr(value) {
    return esc(value);
  }

  function fmtNum(n) {
    var v = Number(n) || 0;
    return v.toLocaleString("zh-CN");
  }

  function fmtDur(seconds) {
    var s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return s + " 秒";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " 分 " + (s % 60) + " 秒";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " 小时 " + (m % 60) + " 分";
    return Math.floor(h / 24) + " 天 " + (h % 24) + " 小时";
  }

  function fmtDurShort(seconds) {
    var s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m" + (s % 60 ? (s % 60) + "s" : "");
    var h = Math.floor(m / 60);
    return h + "h" + (m % 60 ? (m % 60) + "m" : "");
  }

  function fmtDateTime(ts) {
    if (!ts) return "-";
    var d = new Date(Number(ts));
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
      p(d.getHours()) + ":" + p(d.getMinutes())
    );
  }

  function relTime(ts) {
    if (!ts) return "-";
    var diff = Date.now() - Number(ts);
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 2592000000) return Math.floor(diff / 86400000) + " 天前";
    return fmtDateTime(ts).slice(0, 10);
  }

  function todayStr(offsetDays) {
    var d = new Date();
    d.setDate(d.getDate() + (offsetDays || 0));
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }

  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function setHTML(node, html) {
    if (node) node.innerHTML = html;
  }

  /* ------------------------------------------------------------------ 请求层 */

  /** 统一的加载失败卡片：显示原因 + 重试按钮（重试 = 重新执行当前路由渲染） */
  function errorCard(title, msg) {
    return '<div class="card"><div class="empty"><h4>' + esc(title) + "</h4><p>" + esc(msg || "未知错误") + "</p>" +
      '<p style="color:var(--text-3);font-size:12.5px">请检查 NAS 能否访问 github.com（部分网络环境需要代理或镜像）。</p>' +
      '<div style="margin-top:14px"><button class="btn" type="button" id="retryRoute">重试</button></div>' +
      "</div></div>";
  }

  function bindRetry(view) {
    var btn = view && view.querySelector ? view.querySelector("#retryRoute") : null;
    if (btn) btn.addEventListener("click", route);
  }

  function api(path, options) {
    var opts = options || {};
    var init = {
      method: opts.method || "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin"
    };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    // 请求级超时：任何接口最长等待 45 秒，避免界面永久停留在加载态
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 45000);
    init.signal = ctrl.signal;
    return fetch(API_BASE + path, init)
      .catch(function (err) {
        var msg = err && err.name === "AbortError" ? "请求超时，请检查 NAS 网络" : "网络请求失败：" + (err && err.message ? err.message : "未知错误");
        return { ok: false, error: msg, __status: 0 };
      })
      .then(function (res) {
        clearTimeout(timer);
        if (res && res.__status !== undefined) return res; // 已是错误兜底对象
        return res
          .json()
          .catch(function () {
            return { ok: false, error: "服务返回了无法解析的内容（HTTP " + res.status + "）" };
          })
          .then(function (data) {
            if (!res.ok && data && data.ok !== false) data.ok = false;
            data.__status = res.status;
            return data;
          });
      });
  }

  function exportUrl(type, format, inline) {
    var r = state.range;
    var q = new URLSearchParams({
      type: type,
      format: format,
      from: r.from,
      to: r.to
    });
    if (inline) q.set("inline", "1");
    return API_BASE + "/api/export?" + q.toString();
  }

  /* ------------------------------------------------------------------- 状态 */

  var state = {
    me: null,
    system: null,
    users: [],
    filterUid: "",
    range: { preset: "7d", from: todayStr(-6), to: todayStr(0) },
    statsTab: "projects",
    repo: { page: 1, q: "", sort: "updated", loading: false, items: [], total: null },
    explore: { q: "", loading: false, items: [], total: 0 },
    currentView: null, // 当前页面标识，用于埋点去重
    refreshTimer: null
  };

  /* ------------------------------------------------------------------- 主题 */

  var THEME_KEY = "gstats.theme";
  var THEMES = [
    { id: "moonlight", name: "明月", mode: "light", colors: ["#f4f7fc", "#2563eb", "#38bdf8"] },
    { id: "bamboo", name: "青竹", mode: "light", colors: ["#f3f8f4", "#059669", "#34d399"] },
    { id: "wisteria", name: "紫藤", mode: "light", colors: ["#f8f6fd", "#7c3aed", "#a78bfa"] },
    { id: "sunrise", name: "暖阳", mode: "light", colors: ["#fdf9f4", "#d97706", "#fbbf24"] },
    { id: "deepspace", name: "深空", mode: "dark", colors: ["#0a0f1e", "#6366f1", "#818cf8"] },
    { id: "abyss", name: "青碧", mode: "dark", colors: ["#05121a", "#06b6d4", "#22d3ee"] },
    { id: "nightfall", name: "夜幕", mode: "dark", colors: ["#150a11", "#f43f5e", "#fb7185"] },
    { id: "graphite", name: "石墨", mode: "dark", colors: ["#0e1013", "#94a3b8", "#cbd5e1"] }
  ];

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function resolveTheme(name) {
    if (name && name !== "auto") return name;
    return systemPrefersDark() ? "deepspace" : "moonlight";
  }

  function applyTheme(name) {
    var id = resolveTheme(name);
    document.documentElement.setAttribute("data-theme", id);
    return id;
  }

  function storedTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || "auto";
    } catch (e) {
      return "auto";
    }
  }

  function setTheme(name) {
    try {
      localStorage.setItem(THEME_KEY, name);
    } catch (e) {
      /* ignore */
    }
    applyTheme(name);
    renderThemePicker();
    toast("已切换主题：" + themeLabel(name), "success");
  }

  function themeLabel(name) {
    if (name === "auto") return "跟随系统";
    var t = THEMES.filter(function (x) {
      return x.id === name;
    })[0];
    return t ? t.name : name;
  }

  function renderThemePicker() {
    var box = el("themePicker");
    if (!box) return;
    var current = storedTheme();
    var resolved = resolveTheme(current);
    var items = [{ id: "auto", name: "跟随系统", mode: "auto", colors: ["#e2e8f0", "#94a3b8", "#475569"] }].concat(THEMES);
    setHTML(
      box,
      items
        .map(function (t) {
          var active = current === t.id ? " active" : "";
          var modeText = t.mode === "auto" ? "自动" : t.mode === "dark" ? "深色" : "浅色";
          return (
            '<button type="button" class="theme-item' + active + '" data-theme-id="' + attr(t.id) + '">' +
            '<span class="theme-swatch">' +
            t.colors.map(function (c) { return '<i style="background:' + attr(c) + '"></i>'; }).join("") +
            "</span>" +
            '<span class="tn">' + esc(t.name) +
            (current === t.id ? '<span class="chip accent" style="padding:0 6px">当前</span>' : "") +
            "</span>" +
            '<span class="tm">' + esc(modeText) + (t.id === resolved ? " · 生效中" : "") + "</span>" +
            "</button>"
          );
        })
        .join("")
    );
    qsa("[data-theme-id]", box).forEach(function (btn) {
      btn.addEventListener("click", function () {
        setTheme(btn.getAttribute("data-theme-id"));
      });
    });
  }

  /* ------------------------------------------------------------------ 提示层 */

  function toast(message, type) {
    var box = el("toasts");
    if (!box) return;
    var node = document.createElement("div");
    node.className = "toast" + (type ? " " + type : "");
    node.textContent = message;
    box.appendChild(node);
    setTimeout(function () {
      node.style.transition = "opacity .3s, transform .3s";
      node.style.opacity = "0";
      node.style.transform = "translateY(6px)";
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 320);
    }, type === "error" ? 5200 : 2800);
  }

  function openModal(html) {
    closeModal();
    var mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.id = "modalMask";
    mask.innerHTML = '<div class="modal">' + html + "</div>";
    mask.addEventListener("click", function (e) {
      if (e.target === mask) closeModal();
    });
    document.body.appendChild(mask);
    return mask;
  }

  function closeModal() {
    var m = el("modalMask");
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }

  function copyText(text) {
    var done = function () {
      toast("已复制到剪贴板", "success");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        toast("复制失败，请手动选择复制", "error");
      });
      return;
    }
    var ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch (e) {
      toast("复制失败，请手动选择复制", "error");
    }
    document.body.removeChild(ta);
  }

  /* --------------------------------------------------------------- Markdown */

  function renderMarkdown(src) {
    if (!src) return '<p class="muted">该项目没有 README 文件。</p>';
    var text = String(src).replace(/\r\n/g, "\n");
    var codeBlocks = [];

    // 抽出围栏代码块，避免后续被当作普通文本处理
    text = text.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, function (_, lang, code) {
      codeBlocks.push({ lang: lang, code: code });
      return "\u0000CODE" + (codeBlocks.length - 1) + "\u0000";
    });

    text = esc(text);

    // 图片与链接
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, function (_, alt, url) {
      return '<img src="' + attr(url) + '" alt="' + attr(alt) + '" loading="lazy" />';
    });
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, function (_, label, url) {
      var external = /^https?:/i.test(url);
      return (
        '<a href="' + attr(url) + '"' + (external ? ' target="_blank" rel="noopener noreferrer"' : "") + ">" +
        label + "</a>"
      );
    });

    var lines = text.split("\n");
    var out = [];
    var listType = null;
    var inQuote = false;
    var inTable = false;
    var tableRows = [];

    function closeList() {
      if (listType) {
        out.push("</" + listType + ">");
        listType = null;
      }
    }
    function closeQuote() {
      if (inQuote) {
        out.push("</blockquote>");
        inQuote = false;
      }
    }
    function flushTable() {
      if (!inTable) return;
      var head = tableRows.shift() || [];
      var body = tableRows;
      if (head.length && /^[\s|:-]+$/.test(head.join(""))) {
        head = [];
      }
      var html = "<table>";
      if (head.length) {
        html += "<thead><tr>" + head.map(function (c) { return "<th>" + c + "</th>"; }).join("") + "</tr></thead>";
      }
      html += "<tbody>" + body.map(function (row) {
        return "<tr>" + row.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table>";
      out.push(html);
      tableRows = [];
      inTable = false;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();

      if (/^\u0000CODE\d+\u0000$/.test(trimmed)) {
        closeList(); closeQuote(); flushTable();
        out.push(trimmed);
        continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line)) {
        closeList(); closeQuote();
        inTable = true;
        tableRows.push(
          trimmed.replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); })
        );
        continue;
      }
      flushTable();

      if (!trimmed) {
        closeList(); closeQuote();
        continue;
      }

      var heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading) {
        closeList(); closeQuote();
        var lvl = heading[1].length;
        out.push("<h" + lvl + ">" + heading[2] + "</h" + lvl + ">");
        continue;
      }

      if (/^(---|\*\*\*|___)$/.test(trimmed)) {
        closeList(); closeQuote();
        out.push("<hr/>");
        continue;
      }

      if (/^>\s?/.test(trimmed)) {
        closeList();
        if (!inQuote) { out.push("<blockquote>"); inQuote = true; }
        out.push("<p>" + trimmed.replace(/^>\s?/, "") + "</p>");
        continue;
      }
      closeQuote();

      var ul = /^[-*+]\s+(.*)$/.exec(trimmed);
      var ol = /^\d+[.)]\s+(.*)$/.exec(trimmed);
      if (ul) {
        if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
        out.push("<li>" + ul[1] + "</li>");
        continue;
      }
      if (ol) {
        if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
        out.push("<li>" + ol[1] + "</li>");
        continue;
      }
      closeList();
      out.push("<p>" + trimmed + "</p>");
    }
    closeList(); closeQuote(); flushTable();

    var html = out.join("\n");

    // 行内样式
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    // 还原代码块
    html = html.replace(/\u0000CODE(\d+)\u0000/g, function (_, idx) {
      var block = codeBlocks[Number(idx)];
      if (!block) return "";
      return '<pre><code class="lang-' + attr(block.lang || "text") + '">' + esc(block.code) + "</code></pre>";
    });

    return html;
  }

  /* ------------------------------------------------------------------- 图表 */

  function pickTicks(count, maxTicks) {
    var step = Math.max(1, Math.ceil(count / (maxTicks || 8)));
    var out = [];
    for (var i = 0; i < count; i += step) out.push(i);
    return out;
  }

  function chartBars(days, keys) {
    if (!days.length) return emptyChart();
    var W = 760, H = 210, padL = 34, padR = 12, padT = 14, padB = 26;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;
    var max = 1;
    days.forEach(function (d) {
      keys.forEach(function (k) { max = Math.max(max, Number(d[k.key]) || 0); });
    });
    max = Math.ceil(max * 1.15) || 1;
    var slot = innerW / days.length;
    var barW = Math.max(3, Math.min(18, (slot - 6) / keys.length));
    var gridCount = 4;
    var grid = "";
    for (var g = 0; g <= gridCount; g++) {
      var y = padT + (innerH / gridCount) * g;
      var val = Math.round((max / gridCount) * (gridCount - g));
      grid +=
        '<line class="grid-line" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '"/>' +
        '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + val + "</text>";
    }
    var bars = days.map(function (d, i) {
      var baseX = padL + slot * i + (slot - barW * keys.length) / 2;
      return keys.map(function (k, ki) {
        var v = Number(d[k.key]) || 0;
        var h = (v / max) * innerH;
        var x = baseX + barW * ki;
        var y = padT + innerH - h;
        return '<rect class="series-bar' + (ki ? " alt" : "") + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
          '" width="' + Math.max(2, barW - 2).toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) +
          '" rx="2"><title>' + esc(d.day) + " · " + esc(k.label) + "：" + fmtNum(v) + "</title></rect>";
      }).join("");
    }).join("");
    var ticks = pickTicks(days.length, 8).map(function (i) {
      var x = padL + slot * i + slot / 2;
      return '<text x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(days[i].day.slice(5)) + "</text>";
    }).join("");
    return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">' +
      grid + bars + ticks +
      '<line class="axis-line" x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (W - padR) + '" y2="' + (padT + innerH) + '"/>' +
      "</svg>";
  }

  function chartArea(days, key) {
    if (!days.length) return emptyChart();
    var W = 760, H = 210, padL = 44, padR = 12, padT = 14, padB = 26;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;
    var max = 1;
    days.forEach(function (d) { max = Math.max(max, Number(d[key]) || 0); });
    max = Math.ceil(max * 1.15) || 1;
    var step = days.length > 1 ? innerW / (days.length - 1) : innerW;
    var pts = days.map(function (d, i) {
      var v = Number(d[key]) || 0;
      return [padL + step * i, padT + innerH - (v / max) * innerH, d, v];
    });
    var line = pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
    var area =
      padL + "," + (padT + innerH) + " " + line + " " +
      (padL + step * (days.length - 1)).toFixed(1) + "," + (padT + innerH);
    var grid = "";
    for (var g = 0; g <= 4; g++) {
      var y = padT + (innerH / 4) * g;
      var val = Math.round((max / 4) * (4 - g));
      grid +=
        '<line class="grid-line" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '"/>' +
        '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + fmtDurShort(val) + "</text>";
    }
    var dots = pts.map(function (p) {
      return '<circle class="series-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.2"><title>' +
        esc(p[2].day) + "：" + fmtDur(p[3]) + "</title></circle>";
    }).join("");
    var ticks = pickTicks(days.length, 8).map(function (i) {
      return '<text x="' + (padL + step * i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(days[i].day.slice(5)) + "</text>";
    }).join("");
    return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">' +
      grid +
      '<polygon class="series-area" points="' + area + '"/>' +
      '<polyline class="series-line" points="' + line + '"/>' +
      dots + ticks +
      '<line class="axis-line" x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (W - padR) + '" y2="' + (padT + innerH) + '"/>' +
      "</svg>";
  }

  function emptyChart() {
    return '<div class="empty" style="padding:34px 10px">暂无数据</div>';
  }

  function rankList(items, opts) {
    if (!items.length) {
      return '<div class="empty" style="padding:30px 10px"><h4>暂无浏览记录</h4><p>用户在应用内浏览项目后，这里会显示排行</p></div>';
    }
    var max = Math.max.apply(null, items.map(function (i) { return Number(i.value) || 0; })) || 1;
    return '<div class="rank-list">' + items.map(function (item, idx) {
      var pct = Math.max(2, Math.round(((Number(item.value) || 0) / max) * 100));
      return '<div class="rank-item">' +
        '<span class="rank-no' + (idx < 3 ? " top" : "") + '">' + (idx + 1) + "</span>" +
        '<span class="rank-body">' +
        '<div class="rank-name">' + (item.link ? '<a href="' + attr(item.link) + '">' + esc(item.label) + "</a>" : esc(item.label)) + "</div>" +
        '<div class="bar" style="margin-top:5px"><i style="width:' + pct + '%"></i></div>' +
        '<div class="rank-sub">' + (opts && opts.sub ? opts.sub(item) : "") + "</div>" +
        "</span>" +
        '<span class="rank-value">' + esc(item.display || fmtDur(item.value)) + "</span>" +
        "</div>";
    }).join("") + "</div>";
  }

  /* ------------------------------------------------------------------- 埋点 */

  var tracker = {
    id: null,
    timer: null,
    meta: null,
    start: function (kind, target, title, url) {
      tracker.stop();
      tracker.meta = { kind: kind, target: target, title: title, url: url };
      api("/api/track/view", {
        method: "POST",
        body: { kind: kind, target: target, title: title, url: url }
      })
        .then(function (res) {
          if (res && res.ok && res.viewId) {
            tracker.id = res.viewId;
            if (tracker.timer) clearInterval(tracker.timer);
            tracker.timer = setInterval(function () {
              tracker.heartbeat();
            }, HEARTBEAT_MS);
          }
        })
        .catch(function () {
          /* 埋点失败不影响使用 */
        });
    },
    heartbeat: function () {
      if (!tracker.id || document.hidden) return;
      api("/api/track/heartbeat", { method: "POST", body: { viewId: tracker.id } }).catch(function () {});
    },
    stop: function () {
      if (tracker.timer) {
        clearInterval(tracker.timer);
        tracker.timer = null;
      }
      if (!tracker.id) return;
      var id = tracker.id;
      tracker.id = null;
      var body = JSON.stringify({ viewId: id });
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(API_BASE + "/api/track/end", new Blob([body], { type: "application/json" }));
        } else {
          fetch(API_BASE + "/api/track/end", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body,
            keepalive: true
          }).catch(function () {});
        }
      } catch (e) {
        /* ignore */
      }
    }
  };

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) tracker.stop();
    else if (tracker.meta) {
      var m = tracker.meta;
      tracker.meta = null;
      tracker.start(m.kind, m.target, m.title, m.url);
    }
  });
  window.addEventListener("pagehide", function () {
    tracker.stop();
  });

  /* ------------------------------------------------------------------ 时间范围 */

  function applyPreset(preset) {
    var today = todayStr(0);
    if (preset === "today") state.range = { preset: preset, from: today, to: today };
    else if (preset === "7d") state.range = { preset: preset, from: todayStr(-6), to: today };
    else if (preset === "30d") state.range = { preset: preset, from: todayStr(-29), to: today };
    else if (preset === "90d") state.range = { preset: preset, from: todayStr(-89), to: today };
    else if (preset === "year") state.range = { preset: preset, from: todayStr(-364), to: today };
  }

  function rangeToolbar(idPrefix) {
    var p = idPrefix || "r";
    var presets = [
      { id: "today", label: "今天" },
      { id: "7d", label: "近 7 天" },
      { id: "30d", label: "近 30 天" },
      { id: "90d", label: "近 90 天" },
      { id: "year", label: "近一年" }
    ];
    return (
      '<div class="toolbar">' +
      '<div class="seg" id="' + p + 'Presets">' +
      presets.map(function (x) {
        return '<button type="button" data-preset="' + x.id + '"' +
          (state.range.preset === x.id ? ' class="active"' : "") + ">" + x.label + "</button>";
      }).join("") +
      "</div>" +
      '<input class="input" style="width:140px" type="date" id="' + p + 'From" value="' + attr(state.range.from) + '"/>' +
      '<span style="color:var(--text-3)">~</span>' +
      '<input class="input" style="width:140px" type="date" id="' + p + 'To" value="' + attr(state.range.to) + '"/>' +
      '<button class="btn sm" type="button" id="' + p + 'Apply">应用</button>' +
      '<span class="sep"></span>' +
      '<button class="btn sm" type="button" id="' + p + 'Refresh">刷新</button>' +
      userFilterHTML() +
      "</div>"
    );
  }

  function userFilterHTML() {
    if (!state.me || !state.me.identity.isAdmin) return "";
    if (!state.users.length) return "";
    return (
      '<span class="sep"></span>' +
      '<select class="select" id="userFilter" style="width:180px">' +
      '<option value="">全部用户</option>' +
      state.users.map(function (u) {
        var label = (u.fnosUsername || u.uid) + (u.github ? "（@" + u.github.login + "）" : "");
        return '<option value="' + attr(u.uid) + '"' + (state.filterUid === u.uid ? " selected" : "") + ">" + esc(label) + "</option>";
      }).join("") +
      "</select>"
    );
  }

  function bindRangeControls(idPrefix, onChange) {
    var p = idPrefix || "r";
    var seg = el(p + "Presets");
    if (seg) {
      qsa("button", seg).forEach(function (btn) {
        btn.addEventListener("click", function () {
          applyPreset(btn.getAttribute("data-preset"));
          onChange();
        });
      });
    }
    var applyBtn = el(p + "Apply");
    if (applyBtn) {
      applyBtn.addEventListener("click", function () {
        var from = el(p + "From").value;
        var to = el(p + "To").value;
        if (!from || !to) {
          toast("请选择完整的起止日期", "error");
          return;
        }
        if (from > to) {
          var t = from;
          from = to;
          to = t;
        }
        state.range = { preset: "custom", from: from, to: to };
        onChange();
      });
    }
    var refreshBtn = el(p + "Refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        onChange();
      });
    }
    var uf = el("userFilter");
    if (uf) {
      uf.addEventListener("change", function () {
        state.filterUid = uf.value;
        onChange();
      });
    }
  }

  function scopeQuery() {
    return state.filterUid ? "&uid=" + encodeURIComponent(state.filterUid) : "";
  }

  /* ------------------------------------------------------------------- 视图 */

  function icon(name) {
    var paths = {
      dash: '<path d="M3 13h8V3H3v10Zm10 8h8V11h-8v10ZM3 21h8v-6H3v6Zm10-12h8V3h-8v16Z"/>',
      github:
        '<path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.64-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.05.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.06 10.06 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"/>',
      chart: '<path d="M4 20h16v-2H4v2Zm2-4h3V8H6v8Zm5 0h3V4h-3v12Zm5 0h3v-6h-3v6Z"/>',
      search: '<path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5Zm-6 0A4.5 4.5 0 1 1 14 9.5 4.49 4.49 0 0 1 9.5 14Z"/>',
      download: '<path d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-4.7 1.4-1.4 3.3 3.3V3h2ZM4 19h16v2H4v-2Z"/>',
      settings:
        '<path d="M19.4 13a7.8 7.8 0 0 0 0-2l2-1.5-2-3.5-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3H9l-.3 3a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.5L4.6 11a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.5 2.4-1c.5.4 1.1.8 1.7 1l.3 3h6l.3-3c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.5-2-1.5ZM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z"/>',
      logout: '<path d="M10 17l1.4-1.4L8.8 13H16v-2H8.8l2.6-2.6L10 7l-5 5 5 5ZM4 3h8V1H4a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2h8v-2H4V3Z"/>',
      refresh: '<path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"/>',
      star: '<path d="m12 17.3-6.2 3.7 1.6-7L2 9.2l7.1-.6L12 2l2.9 6.6 7.1.6-5.4 4.8 1.6 7Z"/>',
      external: '<path d="M14 3v2h3.6l-9.3 9.3 1.4 1.4L19 6.4V10h2V3h-7ZM5 5h6V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6h-2v6H5V5Z"/>',
      clock: '<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm1 11h-4v-2h2V6h2v7Z"/>',
      users:
        '<path d="M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 1a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm8 2c-2.7 0-8 1.3-8 4v3h16v-3c0-2.7-5.3-4-8-4Zm-8 .5c-1.9-.6-5-1-5 2.5v3h4v-3c0-1 .3-1.9.9-2.5Z"/>'
    };
    return (
      '<svg class="i" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + (paths[name] || paths.chart) + "</svg>"
    );
  }

  var NAV = [
    { hash: "#/", icon: "dash", label: "概览" },
    { hash: "#/github", icon: "github", label: "我的 GitHub" },
    { hash: "#/explore", icon: "search", label: "发现项目" },
    { hash: "#/stats", icon: "chart", label: "统计明细" },
    { hash: "#/reports", icon: "download", label: "报表导出" },
    { hash: "#/settings", icon: "settings", label: "设置", adminOnly: true }
  ];

  function shell(activeHash, title, subtitle, actionsHTML) {
    var identity = state.me ? state.me.identity : { fnosUsername: "未登录", isAdmin: false };
    var gh = state.me && state.me.github;
    return (
      '<div class="app">' +
      '<aside class="sidebar">' +
      '<div class="brand">' +
      '<span class="brand-logo"><img src="' + PREFIX + '/logo-64.png" alt=""/></span>' +
      '<span><span class="brand-name">GStats</span><span class="brand-sub">GitHub 使用统计</span></span>' +
      "</div>" +
      '<div class="nav-label">导航</div>' +
      NAV.filter(function (n) {
        return !n.adminOnly || identity.isAdmin;
      })
        .map(function (n) {
          var active = activeHash === n.hash || (n.hash === "#/github" && activeHash.indexOf("#/repo/") === 0) ? " active" : "";
          return '<button class="nav-item' + active + '" data-hash="' + attr(n.hash) + '">' + icon(n.icon) + "<span>" + esc(n.label) + "</span></button>";
        })
        .join("") +
      '<div class="sidebar-foot">' +
      '<div class="user-chip">' +
      (gh
        ? '<img src="' + attr(gh.avatarUrl) + '" alt="" onerror="this.style.visibility=\'hidden\'"/>'
        : '<span class="avatar" style="display:grid;place-items:center">' + icon("github") + "</span>") +
      '<span class="user-meta">' +
      '<span class="user-name">' + esc(gh ? "@" + gh.login : identity.fnosUsername) + "</span>" +
      '<span class="user-sub">' + (gh ? "已关联 GitHub" : identity.isAdmin ? "管理员 · 未关联" : "未关联 GitHub") + "</span>" +
      "</span>" +
      "</div>" +
      '<div class="sidebar-credit">开发者 <a href="https://github.com/MisiteQ" target="_blank" rel="noopener">Misite齊</a></div>' +
      "</div>" +
      "</aside>" +
      '<main class="main">' +
      '<header class="topbar">' +
      "<div><h1>" + esc(title) + '</h1><div class="sub">' + esc(subtitle || "") + "</div></div>" +
      '<span class="spacer"></span>' +
      (actionsHTML || "") +
      '<button class="btn sm ghost" type="button" id="themeBtn" title="切换主题">' + icon("chart") + "</button>" +
      "</header>" +
      '<div class="content" id="view"></div>' +
      "</main>" +
      "</div>"
    );
  }

  function renderShell(activeHash, title, subtitle, actionsHTML) {
    setHTML(el("root"), shell(activeHash, title, subtitle, actionsHTML));
    qsa("[data-hash]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        location.hash = btn.getAttribute("data-hash");
      });
    });
    var tb = el("themeBtn");
    if (tb) {
      tb.addEventListener("click", function () {
        openThemeModal();
      });
    }
  }

  function openThemeModal() {
    var box = openModal(
      "<h3>主题色</h3>" +
        '<div class="modal-desc">选择你喜欢的配色，设置会保存在本地浏览器中。</div>' +
        '<div class="theme-grid" id="themePicker"></div>' +
        '<div class="modal-actions"><button class="btn" type="button" id="closeTheme">关闭</button></div>'
    );
    renderThemePicker();
    el("closeTheme").addEventListener("click", closeModal);
  }

  /* -------------------------------------------------------------------- 概览 */

  function renderOverview() {
    renderShell("#/", "概览", "今天有多少人登录、看了哪些项目、停留了多久", 
      '<button class="btn sm" type="button" id="ovRefresh">' + icon("refresh") + "刷新</button>");
    var view = el("view");
    setHTML(view, rangeToolbar("ov") + '<div class="loading-row"><span class="spinner"></span> 正在统计 ...</div>');

    bindRangeControls("ov", renderOverviewData);
    var rf = el("ovRefresh");
    if (rf) rf.addEventListener("click", renderOverviewData);
    renderOverviewData();
  }

  function renderOverviewData() {
    var view = el("view");
    if (!view) return;
    var range = state.range;
    setHTML(view, rangeToolbar("ov") + '<div class="loading-row"><span class="spinner"></span> 正在统计 ...</div>');
    bindRangeControls("ov", renderOverviewData);

    Promise.all([
      api("/api/stats/overview?from=" + range.from + "&to=" + range.to + scopeQuery()),
      api("/api/stats/projects?from=" + range.from + "&to=" + range.to + "&limit=10" + scopeQuery()),
      api("/api/stats/summary"),
      api("/api/stats/raw?from=" + range.from + "&to=" + range.to + "&limit=12" + scopeQuery())
    ])
      .then(function (res) {
        var ov = res[0], pr = res[1], sm = res[2], raw = res[3];
        if (!ov.ok) throw new Error(ov.error || "统计接口返回异常");

        var t = ov.totals;
        var today = sm.ok && sm.today ? sm.today : null;

        var stats = [
          { k: "区间登录用户", v: t.loginUsers, u: "人", d: "去重后的登录用户数" },
          { k: "日均登录用户", v: t.avgDailyLoginUsers, u: "人/天", d: "区间内平均每日登录人数" },
          { k: "活跃用户", v: t.activeUsers, u: "人", d: "真正浏览过项目的用户" },
          { k: "浏览次数", v: fmtNum(t.views), u: "", d: "平均单次 " + fmtDur(t.avgSecondsPerView) },
          { k: "总停留时长", v: fmtDur(t.seconds), u: "", d: "区间内累计浏览时长" },
          { k: "涉及项目", v: t.projects, u: "个", d: "被浏览过的项目数量" }
        ];

        var todayCards = today
          ? '<div class="grid c4" style="margin-bottom:14px">' +
            todayStat("今日登录用户", fmtNum(today.loginUsers), "人", "今日打开 GStats 的用户") +
            todayStat("今日活跃用户", fmtNum(today.activeUsers), "人", "今日浏览过项目") +
            todayStat("今日停留时长", fmtDur(today.seconds), "", "今日累计浏览时长") +
            todayStat("今日浏览项目", fmtNum(today.projects), "个", "今日被浏览的项目数") +
            "</div>"
          : "";

        setHTML(
          view,
          rangeToolbar("ov") +
            todayCards +
            '<div class="grid c3">' +
            stats.map(function (s) {
              return (
                '<div class="stat"><div class="k">' + esc(s.k) + '</div><div class="v">' + esc(s.v) +
                (s.u ? "<small>" + esc(s.u) + "</small>" : "") + '</div><div class="d">' + esc(s.d) + "</div></div>"
              );
            }).join("") +
            "</div>" +
            '<div class="grid side" style="margin-top:14px">' +
            '<div class="card"><div class="card-title">每日登录用户与活跃用户<span class="hint">' +
            esc(range.from) + " ~ " + esc(range.to) + "</span></div>" +
            chartBars(ov.days, [
              { key: "loginUsers", label: "登录用户" },
              { key: "activeUsers", label: "活跃用户" }
            ]) +
            '<div class="legend"><span><i style="background:var(--accent)"></i>登录用户</span><span><i style="background:var(--accent-2)"></i>活跃用户</span></div>' +
            "</div>" +
            '<div class="card"><div class="card-title">项目停留时长 TOP 10</div>' +
            rankList(
              (pr.items || []).slice(0, 10).map(function (p) {
                return {
                  label: p.target,
                  value: p.seconds,
                  link: "#/repo/" + p.target,
                  display: fmtDur(p.seconds)
                };
              }),
              {
                sub: function (item) {
                  var found = (pr.items || []).filter(function (x) { return x.target === item.label; })[0];
                  return found ? found.users + " 人访问 · " + found.views + " 次" : "";
                }
              }
            ) +
            "</div>" +
            "</div>" +
            '<div class="grid side" style="margin-top:14px">' +
            '<div class="card"><div class="card-title">每日停留时长趋势</div>' + chartArea(ov.days, "seconds") + "</div>" +
            '<div class="card"><div class="card-title">最近浏览记录</div>' +
            (raw.ok && raw.items.length
              ? '<div class="table-wrap"><table class="data"><thead><tr><th>时间</th><th>用户</th><th>项目</th><th style="text-align:right">停留</th></tr></thead><tbody>' +
                raw.items
                  .map(function (r) {
                    return "<tr><td>" + esc(relTime(r.ts)) + "</td><td>" + esc(r.fnosUser || r.uid) +
                      (r.githubLogin ? ' <span class="muted">@' + esc(r.githubLogin) + "</span>" : "") +
                      '</td><td><a href="#/repo/' + attr(r.target) + '">' + esc(r.target) + "</a></td>" +
                      '<td class="num">' + esc(fmtDur(r.seconds)) + "</td></tr>";
                  })
                  .join("") +
                "</tbody></table></div>"
              : '<div class="empty" style="padding:26px 10px"><h4>暂无浏览记录</h4><p>用户在应用内浏览项目后这里会实时显示</p></div>') +
            "</div>" +
            "</div>"
        );
        bindRangeControls("ov", renderOverviewData);
      })
      .catch(function (err) {
        setHTML(
          view,
          rangeToolbar("ov") + errorCard("统计加载失败", err && err.message ? err.message : "网络请求失败")
        );
        bindRangeControls("ov", renderOverviewData);
        bindRetry(view);
      });
  }

  function todayStat(k, v, u, d) {
    return (
      '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) +
      (u ? "<small>" + esc(u) + "</small>" : "") + '</div><div class="d">' + esc(d) + "</div></div>"
    );
  }

  /* ---------------------------------------------------------------- 我的 GitHub */

  function renderGithub() {
    renderShell("#/github", "我的 GitHub", "登录 GitHub 账号即可浏览自己的仓库，浏览行为会被自动统计");
    var view = el("view");
    if (!state.me.linked) {
      renderLoginCard(view);
      return;
    }
    setHTML(view, '<div class="loading-row"><span class="spinner"></span> 正在加载 GitHub 资料 ...</div>');
    Promise.all([
      api("/api/github/profile"),
      api("/api/github/repos?page=1&perPage=30&sort=updated")
    ]).then(function (res) {
      var profile = res[0], repos = res[1];
      var html = "";
      if (profile.ok) {
        var p = profile.data;        html +=
          '<div class="card"><div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">' +
          '<img class="avatar lg" src="' + attr(p.avatar_url) + '" alt=""/>' +
          '<div style="flex:1;min-width:220px">' +
          '<div style="font-size:17px;font-weight:700">' + esc(p.name || p.login) +
          ' <span style="color:var(--text-3);font-weight:400">@' + esc(p.login) + "</span></div>" +
          (p.bio ? '<div style="color:var(--text-2);font-size:13px;margin-top:4px">' + esc(p.bio) + "</div>" : "") +
          '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:12.5px;color:var(--text-3)">' +
          "<span>" + icon("star") + " 仓库 " + fmtNum(p.public_repos) + "</span>" +
          "<span>关注者 " + fmtNum(p.followers) + "</span>" +
          "<span>正在关注 " + fmtNum(p.following) + "</span>" +
          (p.location ? "<span>" + esc(p.location) + "</span>" : "") +
          "</div>" +
          "</div>" +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<a class="btn sm" href="' + attr(p.html_url) + '" target="_blank" rel="noopener noreferrer">' + icon("external") + "打开 GitHub</a>" +
          '<button class="btn sm danger" type="button" id="unlinkBtn">' + icon("logout") + "退出登录</button>" +
          "</div>" +
          "</div></div>";
      } else {
        setHTML(view, errorCard("读取 GitHub 资料失败", profile.error || "无法连接 GitHub"));
        bindRetry(view);
        return;
      }

      html +=
        '<div class="card"><div class="card-title">我的仓库' +
        '<span class="hint">点击任意仓库即可查看详情，停留时长会被自动记录</span></div>' +
        '<div class="toolbar" style="margin-top:12px">' +
        '<input class="input" style="max-width:280px" id="repoSearch" placeholder="搜索我的仓库 ..." value="' + attr(state.repo.q) + '"/>' +
        '<select class="select" style="width:150px" id="repoSort">' +
        ['updated:最近更新', 'stars:星标最多', 'pushed:最近推送', 'name:名称排序'].map(function (o) {
          var parts = o.split(":");
          return '<option value="' + parts[0] + '"' + (state.repo.sort === parts[0] ? " selected" : "") + ">" + parts[1] + "</option>";
        }).join("") +
        "</select>" +
        '<span class="spacer"></span><span class="chip" id="repoCount"></span>' +
        "</div>" +
        '<div id="repoList"><div class="loading-row"><span class="spinner"></span> 加载中 ...</div></div>' +
        '<div style="display:flex;justify-content:center;gap:8px;margin-top:14px" id="repoPager"></div>' +
        "</div>";

      setHTML(view, html);
      bindRepoList(repos);
      var ub = el("unlinkBtn");
      if (ub) {
        ub.addEventListener("click", function () {
          if (!confirm("退出登录将解除本机与 GitHub 账号的关联，确定继续？")) return;
          api("/api/auth/logout", { method: "POST" }).then(function () {
            toast("已退出 GitHub 登录", "success");
            loadMe(true).then(renderGithub);
          });
        });
      }
      var si = el("repoSearch");
      var debounce = null;
      if (si) {
        si.addEventListener("input", function () {
          clearTimeout(debounce);
          debounce = setTimeout(function () {
            state.repo.q = si.value.trim();
            state.repo.page = 1;
            loadRepos();
          }, 380);
        });
      }
      var so = el("repoSort");
      if (so) {
        so.addEventListener("change", function () {
          state.repo.sort = so.value;
          state.repo.page = 1;
          loadRepos();
        });
      }
      })
      .catch(function (err) {
        setHTML(view, errorCard("GitHub 资料加载失败", err && err.message ? err.message : "网络请求失败"));
        bindRetry(view);
      });
  }

  function bindRepoList(repos) {
    if (!repos.ok) {
      var failBox = el("repoList");
      var failCount = el("repoCount");
      if (failBox) setHTML(failBox, '<div class="empty"><h4>仓库加载失败</h4><p>' + esc(repos.error || "无法连接 GitHub") + "</p></div>");
      if (failCount) failCount.textContent = "加载失败";
      return;
    }
    state.repo.items = repos.items;
    state.repo.total = repos.total;
    paintRepoList();
  }

  function loadRepos() {
    var box = el("repoList");
    if (box) setHTML(box, '<div class="loading-row"><span class="spinner"></span> 加载中 ...</div>');
    var q = state.repo.q ? "&q=" + encodeURIComponent(state.repo.q) : "";
    api("/api/github/repos?page=" + state.repo.page + "&perPage=30&sort=" + encodeURIComponent(state.repo.sort) + q)
      .then(function (res) {
        if (!res.ok) {
          setHTML(box, '<div class="empty"><h4>仓库加载失败</h4><p>' + esc(res.error || "") + "</p></div>");
          return;
        }
        state.repo.items = res.items;
        state.repo.total = res.total;
        paintRepoList();
      })
      .catch(function (err) {
        setHTML(box, '<div class="empty"><h4>仓库加载失败</h4><p>' + esc(err.message) + "</p></div>");
      });
  }

  function paintRepoList() {
    var box = el("repoList");
    var pager = el("repoPager");
    var count = el("repoCount");
    if (!box) return;
    var items = state.repo.items;
    if (count) {
      count.textContent = (state.repo.total !== null && state.repo.total !== undefined
        ? "共 " + fmtNum(state.repo.total) + " 个仓库"
        : "第 " + state.repo.page + " 页 · " + items.length + " 个仓库");
    }
    if (!items.length) {
      setHTML(box, '<div class="empty"><h4>没有找到仓库</h4><p>换个关键词试试</p></div>');
      if (pager) setHTML(pager, "");
      return;
    }
    setHTML(
      box,
      '<div class="repo-grid">' +
        items
          .map(function (r) {
            return (
              '<div class="repo-card" data-target="' + attr(r.fullName) + '" data-title="' + attr(r.name) + '">' +
              '<div class="rc-name">' +
              (r.private ? '<span class="chip">私有</span>' : "") +
              '<span class="owner">' + esc(r.owner) + "/</span><span>" + esc(r.name) + "</span>" +
              (r.fork ? '<span class="chip">Fork</span>' : "") +
              "</div>" +
              '<div class="rc-desc">' + esc(r.description || "暂无描述") + "</div>" +
              '<div class="rc-foot">' +
              (r.language ? '<span><i class="lang-dot"></i>' + esc(r.language) + "</span>" : "") +
              '<span>' + icon("star") + " " + fmtNum(r.stars) + "</span>" +
              "<span>Fork " + fmtNum(r.forks) + "</span>" +
              "<span>" + esc(String(r.updatedAt || "").slice(0, 10)) + "</span>" +
              "</div></div>"
            );
          })
          .join("") +
        "</div>"
    );
    qsa(".repo-card", box).forEach(function (card) {
      card.addEventListener("click", function () {
        location.hash = "#/repo/" + card.getAttribute("data-target");
      });
    });
    if (pager) {
      setHTML(
        pager,
        '<button class="btn sm" type="button" id="prevPage"' + (state.repo.page <= 1 ? " disabled" : "") + ">上一页</button>" +
          '<span class="chip">第 ' + state.repo.page + " 页</span>" +
          '<button class="btn sm" type="button" id="nextPage"' + (items.length < 30 ? " disabled" : "") + ">下一页</button>"
      );
      var prev = el("prevPage");
      var next = el("nextPage");
      if (prev) prev.addEventListener("click", function () {
        if (state.repo.page > 1) {
          state.repo.page -= 1;
          loadRepos();
        }
      });
      if (next) next.addEventListener("click", function () {
        state.repo.page += 1;
        loadRepos();
      });
    }
  }

  function renderLoginCard(view) {
    var sys = state.system || {};
    var oauthReady = sys.oauthConfigured;
    var cbUrl = (sys.publicBaseUrl || location.origin) + PREFIX + "/api/auth/github/callback";
    setHTML(
      view,
      '<div class="grid side">' +
        '<div class="card">' +
        '<div class="card-title">使用 GitHub 账号登录</div>' +
        '<div class="card-desc">登录后即可在 GStats 内浏览你自己的仓库与项目详情，浏览的项目和停留时长会自动记入统计。</div>' +
        '<div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">' +
        '<button class="btn primary" type="button" id="oauthLogin"' + (oauthReady ? "" : " disabled") + ">" +
        icon("github") + " 使用 GitHub 授权登录</button>" +
        '<button class="btn" type="button" id="patLogin">使用个人访问令牌登录</button>' +
        "</div>" +
        (oauthReady
          ? ""
          : '<div class="card-desc" style="margin-top:12px;color:var(--warning)">尚未配置 OAuth 凭据，请先在「设置」中填写 GitHub OAuth App 的 Client ID 与 Client Secret，或改用个人访问令牌。</div>') +
        '<div style="margin-top:22px;border-top:1px dashed var(--border);padding-top:14px">' +
        '<div class="card-title" style="font-size:13px">OAuth App 回调地址</div>' +
        '<div class="copy-row" style="margin-top:8px"><input class="input mono" readonly value="' + attr(cbUrl) + '" id="cbUrl"/>' +
        '<button class="btn sm" type="button" id="copyCb">复制</button></div>' +
        '<div class="card-desc">在 GitHub → Settings → Developer settings → OAuth Apps 中把该地址填入 Authorization callback URL。</div>' +
        "</div>" +
        "</div>" +
        '<div class="card"><div class="card-title">关于统计口径</div>' +
        '<ul style="padding-left:18px;color:var(--text-2);font-size:13px;line-height:1.9;margin:10px 0 0">' +
        "<li><b>登录用户</b>：当日打开 GStats 的去重用户数</li>" +
        "<li><b>活跃用户</b>：当日真正浏览过至少一个项目的用户数</li>" +
        "<li><b>项目停留时长</b>：从进入项目详情到离开的计时，15 秒一次心跳累计</li>" +
        "<li>数据全部保存在本机 NAS，不会上传到任何第三方</li>" +
        "</ul>" +
        '<div class="about-dev" style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--border)">开发者 <b>Misite齊</b> · ' +
        '<a href="https://github.com/MisiteQ" target="_blank" rel="noopener">' + icon("github") + " github.com/MisiteQ</a></div>" +
        "</div>" +
        "</div>"
    );

    var oauthBtn = el("oauthLogin");
    if (oauthBtn && oauthReady) {
      oauthBtn.addEventListener("click", function () {
        window.location.href = API_BASE + "/api/auth/github/start";
      });
    }
    var copyBtn = el("copyCb");
    if (copyBtn) copyBtn.addEventListener("click", function () { copyText(cbUrl); });

    var patBtn = el("patLogin");
    if (patBtn) {
      patBtn.addEventListener("click", function () {
        openModal(
          "<h3>使用个人访问令牌登录</h3>" +
            '<div class="modal-desc">在 GitHub → Settings → Developer settings → Personal access tokens 中创建一个具备 <code>read:user</code>（如需私有仓库再加 <code>repo</code>）权限的令牌，粘贴到下方。令牌仅保存在本机 NAS。</div>' +
            '<div class="field"><label>Personal Access Token</label>' +
            '<input class="input mono" id="patInput" type="password" placeholder="ghp_..." autocomplete="off"/></div>' +
            '<div class="modal-actions"><button class="btn" type="button" id="patCancel">取消</button>' +
            '<button class="btn primary" type="button" id="patSubmit">登录</button></div>'
        );
        el("patCancel").addEventListener("click", closeModal);
        el("patSubmit").addEventListener("click", function () {
          var token = el("patInput").value.trim();
          if (!token) {
            toast("请填写令牌", "error");
            return;
          }
          var btn = el("patSubmit");
          btn.disabled = true;
          btn.textContent = "校验中 ...";
          api("/api/auth/pat", { method: "POST", body: { token: token } }).then(function (res) {
            if (!res.ok) {
              btn.disabled = false;
              btn.textContent = "登录";
              toast(res.error || "登录失败", "error");
              return;
            }
            closeModal();
            toast("已关联 GitHub 账号 @" + res.github.login, "success");
            loadMe(true).then(renderGithub);
          });
        });
      });
    }
  }

  /* ---------------------------------------------------------------- 仓库详情 */

  function renderRepo(owner, name) {
    var full = owner + "/" + name;
    state.currentView = "repo:" + full;
    renderShell(
      "#/github",
      full,
      "项目详情 · 停留时长正在统计中",
      '<a class="btn sm" href="https://github.com/' + attr(full) + '" target="_blank" rel="noopener noreferrer">' +
        icon("external") + "在 GitHub 打开</a>"
    );
    var view = el("view");
    setHTML(view, '<div class="loading-row"><span class="spinner"></span> 正在加载项目信息 ...</div>');

    // 进入项目详情即开始计时
    tracker.start("repo", full, full, "https://github.com/" + full);

    Promise.all([
      api("/api/github/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name)),
      api("/api/github/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/readme")
    ]).then(function (res) {
      var detail = res[0], readme = res[1];
      if (!detail.ok) {
        setHTML(
          view,
          '<div class="card"><div class="empty"><h4>无法加载项目</h4><p>' + esc(detail.error || "") + "</p>" +
            '<div style="margin-top:14px"><button class="btn" type="button" onclick="history.back()">返回</button></div></div></div>'
        );
        return;
      }
      var r = detail.repo;
      var langs = detail.languages || {};
      var langTotal = Object.keys(langs).reduce(function (s, k) { return s + langs[k]; }, 0) || 1;

      var html =
        '<div class="card">' +
        "<div style=\"display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap\">" +
        (r.ownerAvatar ? '<img class="avatar lg" src="' + attr(r.ownerAvatar) + '" alt=""/>' : "") +
        '<div style="flex:1;min-width:240px">' +
        '<div style="font-size:18px;font-weight:700">' + esc(r.fullName) +
        (r.private ? ' <span class="chip">私有</span>' : "") +
        (r.archived ? ' <span class="chip warn">已归档</span>' : "") +
        "</div>" +
        '<div style="color:var(--text-2);font-size:13px;margin-top:6px">' + esc(r.description || "暂无描述") + "</div>" +
        '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:12.5px;color:var(--text-3)">' +
        "<span>" + icon("star") + " " + fmtNum(r.stars) + " 星标</span>" +
        "<span>Fork " + fmtNum(r.forks) + "</span>" +
        "<span>Issue " + fmtNum(r.openIssues) + "</span>" +
        "<span>默认分支 " + esc(r.defaultBranch) + "</span>" +
        "<span>更新于 " + esc(String(r.pushedAt || r.updatedAt).slice(0, 10)) + "</span>" +
        "</div>" +
        (r.topics && r.topics.length
          ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">' +
            r.topics.slice(0, 12).map(function (t) { return '<span class="chip accent">' + esc(t) + "</span>"; }).join("") +
            "</div>"
          : "") +
        "</div>" +
        '<div style="min-width:200px">' +
        '<div class="card-title" style="font-size:12.5px">语言构成</div>' +
        Object.keys(langs)
          .sort(function (a, b) { return langs[b] - langs[a]; })
          .slice(0, 6)
          .map(function (k) {
            var pct = Math.round((langs[k] / langTotal) * 100);
            return (
              '<div style="margin-top:7px;font-size:12px">' +
              '<div style="display:flex;justify-content:space-between;color:var(--text-2)"><span>' + esc(k) + "</span><span>" + pct + "%</span></div>" +
              '<div class="bar" style="margin-top:3px"><i style="width:' + pct + '%"></i></div>' +
              "</div>"
            );
          })
          .join("") +
        "</div>" +
        "</div>" +
        "</div>" +
        '<div class="card"><div class="tabs" id="repoTabs">' +
        '<button type="button" data-tab="readme" class="active">README</button>' +
        '<button type="button" data-tab="issues">Issues</button>' +
        '<button type="button" data-tab="commits">最近提交</button>' +
        "</div>" +
        '<div id="repoTabBody">' +
        (readme.ok && readme.readme ? '<div class="md">' + renderMarkdown(readme.readme.content) + "</div>" : '<div class="empty"><h4>没有 README</h4><p>该项目暂时没有说明文件</p></div>') +
        "</div></div>";

      setHTML(view, html);

      var loaded = { readme: true };
      qsa("#repoTabs button").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var tab = btn.getAttribute("data-tab");
          qsa("#repoTabs button").forEach(function (b) { b.classList.remove("active"); });
          btn.classList.add("active");
          if (loaded[tab]) return;
          loaded[tab] = true;
          var body = el("repoTabBody");
          setHTML(body, '<div class="loading-row"><span class="spinner"></span> 加载中 ...</div>');
          var url =
            tab === "issues"
              ? "/api/github/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/issues"
              : "/api/github/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + "/commits";
          api(url).then(function (res2) {
            if (!res2.ok) {
              setHTML(body, '<div class="empty"><h4>加载失败</h4><p>' + esc(res2.error || "") + "</p></div>");
              return;
            }
            if (!res2.items.length) {
              setHTML(body, '<div class="empty"><h4>暂无数据</h4></div>');
              return;
            }
            if (tab === "issues") {
              setHTML(
                body,
                '<div class="table-wrap"><table class="data"><thead><tr><th>编号</th><th>标题</th><th>提交者</th><th>评论</th><th>更新时间</th></tr></thead><tbody>' +
                  res2.items
                    .map(function (it) {
                      return "<tr><td>#" + esc(it.number) + "</td>" +
                        '<td><a href="' + attr(it.htmlUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(it.title) + "</a></td>" +
                        "<td>" + esc(it.user) + "</td><td>" + esc(it.comments) + "</td><td>" + esc(relTime(Date.parse(it.updatedAt))) + "</td></tr>";
                    })
                    .join("") +
                  "</tbody></table></div>"
              );
            } else {
              setHTML(
                body,
                '<div class="table-wrap"><table class="data"><thead><tr><th>提交</th><th>说明</th><th>作者</th><th>时间</th></tr></thead><tbody>' +
                  res2.items
                    .map(function (c) {
                      return "<tr><td class=\"mono\">" + esc(c.sha) + "</td>" +
                        '<td><a href="' + attr(c.htmlUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(c.message) + "</a></td>" +
                        "<td>" + esc(c.author) + "</td><td>" + esc(relTime(Date.parse(c.date))) + "</td></tr>";
                    })
                    .join("") +
                  "</tbody></table></div>"
              );
            }
          });
        });
      });
    }).catch(function (err) {
      setHTML(view, errorCard("项目信息加载失败", err && err.message ? err.message : "网络请求失败"));
      bindRetry(view);
    });
  }

  /* ---------------------------------------------------------------- 发现项目 */

  function renderExplore() {
    renderShell("#/explore", "发现项目", "搜索 GitHub 上的任意仓库，打开即计入项目浏览统计");
    state.currentView = "explore";
    var view = el("view");
    setHTML(
      view,
      '<div class="card">' +
        '<div class="toolbar">' +
        '<input class="input" style="max-width:420px" id="exInput" placeholder="搜索仓库，例如 vue、machine learning、owner/name ..." value="' + attr(state.explore.q) + '"/>' +
        '<button class="btn primary" type="button" id="exBtn">' + icon("search") + "搜索</button>" +
        '<button class="btn" type="button" id="exPopular">随机推荐</button>' +
        "</div>" +
        '<div class="card-desc">提示：需要在「我的 GitHub」中完成登录后才可以搜索。</div>' +
        "</div>" +
        '<div class="card" id="exResults"><div class="empty"><h4>输入关键词开始搜索</h4><p>也可以直接点击「随机推荐」看看热门项目</p></div></div>'
    );
    var input = el("exInput");
    var doSearch = function (q) {
      if (!state.me.linked) {
        toast("请先登录 GitHub 账号", "error");
        return;
      }
      state.explore.q = q;
      var box = el("exResults");
      setHTML(box, '<div class="loading-row"><span class="spinner"></span> 搜索中 ...</div>');
      api("/api/github/search?q=" + encodeURIComponent(q) + "&perPage=24").then(function (res) {
        if (!res.ok) {
          setHTML(box, '<div class="empty"><h4>搜索失败</h4><p>' + esc(res.error || "") + "</p></div>");
          return;
        }
        if (!res.items.length) {
          setHTML(box, '<div class="empty"><h4>没有找到相关仓库</h4><p>换个关键词试试</p></div>');
          return;
        }
        setHTML(
          box,
          '<div class="card-title">搜索结果<span class="hint">共 ' + fmtNum(res.total) + " 个 · 点击查看详情</span></div>" +
            '<div class="repo-grid" style="margin-top:12px">' +
            res.items
              .map(function (r) {
                return (
                  '<div class="repo-card" data-target="' + attr(r.fullName) + '">' +
                  '<div class="rc-name"><span class="owner">' + esc(r.owner) + "/</span><span>" + esc(r.name) + "</span></div>" +
                  '<div class="rc-desc">' + esc(r.description || "暂无描述") + "</div>" +
                  '<div class="rc-foot">' +
                  (r.language ? '<span><i class="lang-dot"></i>' + esc(r.language) + "</span>" : "") +
                  '<span>' + icon("star") + " " + fmtNum(r.stars) + "</span>" +
                  "<span>Fork " + fmtNum(r.forks) + "</span>" +
                  "</div></div>"
                );
              })
              .join("") +
            "</div>"
        );
        qsa(".repo-card", box).forEach(function (card) {
          card.addEventListener("click", function () {
            location.hash = "#/repo/" + card.getAttribute("data-target");
          });
        });
      });
    };
    el("exBtn").addEventListener("click", function () { doSearch(input.value.trim()); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") doSearch(input.value.trim());
    });
    el("exPopular").addEventListener("click", function () {
      var pool = ["stars:>30000", "language:javascript", "language:python", "topic:ai", "language:go", "topic:nas"];
      doSearch(pool[Math.floor(Math.random() * pool.length)]);
    });
  }

  /* ---------------------------------------------------------------- 统计明细 */

  var STATS_TABS = [
    { id: "projects", label: "项目热度" },
    { id: "users", label: "用户明细" },
    { id: "user_projects", label: "用户 × 项目" },
    { id: "daily", label: "每日汇总" },
    { id: "raw", label: "原始记录" }
  ];

  function renderStats() {
    renderShell("#/stats", "统计明细", "从项目、用户、日期等维度查看浏览明细");
    var view = el("view");
    setHTML(
      view,
      rangeToolbar("st") +
        '<div class="card"><div class="tabs" id="statsTabs">' +
        STATS_TABS.map(function (t) {
          return '<button type="button" data-tab="' + t.id + '"' + (state.statsTab === t.id ? ' class="active"' : "") + ">" + t.label + "</button>";
        }).join("") +
        "</div>" +
        '<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn sm" type="button" id="stExport">' +
        icon("download") + "导出当前报表</button></div>" +
        '<div id="statsBody"><div class="loading-row"><span class="spinner"></span> 加载中 ...</div></div></div>'
    );
    bindRangeControls("st", loadStatsTab);
    qsa("#statsTabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        qsa("#statsTabs button").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        state.statsTab = btn.getAttribute("data-tab");
        loadStatsTab();
      });
    });
    el("stExport").addEventListener("click", function () {
      window.location.href = exportUrl(state.statsTab, "csv");
    });
    loadStatsTab();
  }

  function loadStatsTab() {
    var body = el("statsBody");
    if (!body) return;
    var range = state.range;
    setHTML(body, '<div class="loading-row"><span class="spinner"></span> 加载中 ...</div>');
    var base = "&from=" + range.from + "&to=" + range.to + scopeQuery();
    var tab = state.statsTab;
    var path = tab === "raw" ? "/api/stats/raw?limit=500" + base
      : tab === "daily" ? "/api/stats/overview?" + base.slice(1)
      : "/api/stats/" + (tab === "user_projects" ? "user-projects" : tab) + "?limit=300" + base;

    api(path).then(function (res) {
      if (!res.ok) {
        setHTML(body, '<div class="empty"><h4>加载失败</h4><p>' + esc(res.error || "") + "</p></div>");
        return;
      }
      setHTML(body, renderStatsTable(tab, res));
    });
  }

  function renderStatsTable(tab, res) {
    if (tab === "daily") {
      var days = res.days || [];
      return (
        '<div class="table-wrap"><table class="data"><thead><tr>' +
        "<th>日期</th><th>登录用户</th><th>活跃用户</th><th>授权登录次数</th><th>打开应用</th><th>浏览次数</th><th>项目数</th><th>停留时长</th>" +
        "</tr></thead><tbody>" +
        days
          .slice()
          .reverse()
          .map(function (d) {
            return "<tr><td>" + esc(d.day) + "</td><td>" + d.loginUsers + "</td><td>" + d.activeUsers + "</td><td>" +
              d.authLogins + "</td><td>" + d.appOpens + "</td><td>" + d.views + "</td><td>" + d.projects + "</td><td>" +
              esc(fmtDur(d.seconds)) + "</td></tr>";
          })
          .join("") +
        "</tbody></table></div>"
      );
    }
    var items = res.items || [];
    if (!items.length) {
      return '<div class="empty"><h4>该时间段暂无数据</h4><p>调整时间范围或让用户在应用内浏览项目</p></div>';
    }
    if (tab === "projects") {
      return (
        '<div class="table-wrap"><table class="data"><thead><tr><th>项目</th><th>访问人数</th><th>浏览次数</th><th>总停留</th><th>平均停留</th><th>最后访问</th><th>访问者</th></tr></thead><tbody>' +
        items
          .map(function (p) {
            return "<tr><td><a href=\"#/repo/" + attr(p.target) + '">' + esc(p.target) + "</a></td>" +
              "<td>" + p.users + "</td><td>" + p.views + "</td><td>" + esc(fmtDur(p.seconds)) + "</td><td>" +
              esc(fmtDur(p.avgSeconds)) + "</td><td>" + esc(fmtDateTime(p.lastAt)) + "</td>" +
              '<td class="muted">' + esc((p.userList || []).map(function (x) { return "@" + x; }).join(" ")) + "</td></tr>";
          })
          .join("") +
        "</tbody></table></div>"
      );
    }
    if (tab === "users") {
      return (
        '<div class="table-wrap"><table class="data"><thead><tr><th>用户</th><th>GitHub</th><th>活跃天数</th><th>授权登录</th><th>打开应用</th><th>浏览次数</th><th>项目数</th><th>总停留</th><th>最后活动</th></tr></thead><tbody>' +
        items
          .map(function (u) {
            return "<tr><td>" + esc(u.fnosUser || u.uid) + "</td><td>" +
              (u.githubLogin ? '<a href="https://github.com/' + attr(u.githubLogin) + '" target="_blank" rel="noopener noreferrer">@' + esc(u.githubLogin) + "</a>" : '<span class="muted">未关联</span>') +
              "</td><td>" + u.activeDays + "</td><td>" + u.logins + "</td><td>" + u.appOpens + "</td><td>" + u.views +
              "</td><td>" + u.projectCount + "</td><td>" + esc(fmtDur(u.seconds)) + "</td><td>" + esc(fmtDateTime(u.lastAt)) + "</td></tr>";
          })
          .join("") +
        "</tbody></table></div>"
      );
    }
    if (tab === "user_projects") {
      return (
        '<div class="table-wrap"><table class="data"><thead><tr><th>用户</th><th>GitHub</th><th>项目</th><th>访问天数</th><th>浏览次数</th><th>总停留</th><th>平均停留</th><th>最后访问</th></tr></thead><tbody>' +
        items
          .map(function (r) {
            return "<tr><td>" + esc(r.fnosUser || r.uid) + "</td><td>" +
              (r.githubLogin ? "@" + esc(r.githubLogin) : '<span class="muted">-</span>') +
              '</td><td><a href="#/repo/' + attr(r.target) + '">' + esc(r.target) + "</a></td><td>" + r.activeDays +
              "</td><td>" + r.views + "</td><td>" + esc(fmtDur(r.seconds)) + "</td><td>" + esc(fmtDur(r.avgSeconds)) +
              "</td><td>" + esc(fmtDateTime(r.lastAt)) + "</td></tr>";
          })
          .join("") +
        "</tbody></table></div>"
      );
    }
    return (
      '<div class="table-wrap"><table class="data"><thead><tr><th>时间</th><th>用户</th><th>GitHub</th><th>类型</th><th>项目</th><th>停留时长</th><th>开始</th><th>结束</th></tr></thead><tbody>' +
      items
        .map(function (r) {
          return "<tr><td>" + esc(fmtDateTime(r.ts)) + "</td><td>" + esc(r.fnosUser || r.uid) + "</td><td>" +
            (r.githubLogin ? "@" + esc(r.githubLogin) : '<span class="muted">-</span>') + "</td><td>" + esc(r.kind) +
            "</td><td>" + esc(r.target) + "</td><td>" + esc(fmtDur(r.seconds)) + "</td><td>" + esc(fmtDateTime(r.startedAt)) +
            "</td><td>" + esc(fmtDateTime(r.endedAt)) + "</td></tr>";
        })
        .join("") +
      "</tbody></table></div>"
    );
  }

  /* ---------------------------------------------------------------- 报表导出 */

  var REPORT_TYPES = [
    { id: "daily", label: "每日汇总报表", desc: "每天有多少用户登录、浏览了多少项目、停留多久" },
    { id: "users", label: "用户明细报表", desc: "每个飞牛用户 / GitHub 账号的活跃天数、浏览次数与总时长" },
    { id: "projects", label: "项目热度报表", desc: "每个项目被多少人看过、总时长与平均停留时长" },
    { id: "user_projects", label: "用户 × 项目报表", desc: "某位用户分别看了哪些项目、各看了多久" },
    { id: "raw", label: "原始访问记录", desc: "每一条浏览记录的精确起止时间，适合二次分析" }
  ];

  function renderReports() {
    renderShell("#/reports", "报表导出", "导出 CSV / JSON / HTML 三种格式，可直接用 Excel 打开");
    var view = el("view");
    var shareDir = (state.system && state.system.shareDir) || "";
    setHTML(
      view,
      rangeToolbar("rp") +
        '<div class="card">' +
        '<div class="card-title">选择报表</div>' +
        '<div class="grid c3" style="margin-top:12px">' +
        REPORT_TYPES.map(function (t) {
          return (
            '<div class="theme-item" data-report="' + t.id + '" style="cursor:pointer">' +
            '<div class="tn">' + esc(t.label) + "</div>" +
            '<div class="tm" style="line-height:1.6">' + esc(t.desc) + "</div>" +
            "</div>"
          );
        }).join("") +
        "</div>" +
        '<div class="form-row" style="margin-top:16px">' +
        '<div class="field"><label>报表类型</label><select class="select" id="rpType">' +
        REPORT_TYPES.map(function (t) {
          return '<option value="' + t.id + '">' + esc(t.label) + "</option>";
        }).join("") +
        "</select></div>" +
        '<div class="field"><label>导出格式</label><select class="select" id="rpFormat">' +
        '<option value="csv">CSV（Excel 可直接打开）</option>' +
        '<option value="json">JSON（结构化数据）</option>' +
        '<option value="html">HTML（可打印报告）</option>' +
        "</select></div>" +
        "</div>" +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<button class="btn primary" type="button" id="rpDownload">' + icon("download") + "下载报表</button>" +
        '<button class="btn" type="button" id="rpPreview">' + icon("external") + "在新窗口预览</button>" +
        "</div>" +
        (shareDir
          ? '<div class="card-desc" style="margin-top:12px">报表同时会保存一份到共享目录：<code>' + esc(shareDir) + "/reports</code>，可在飞牛文件管理器中直接取走。</div>"
          : "") +
        "</div>" +
        '<div class="card"><div class="card-title">当前统计范围</div>' +
        '<div class="card-desc" id="rpScope"></div>' +
        '<div id="rpScopeBody" style="margin-top:12px"></div>' +
        "</div>"
    );

    bindRangeControls("rp", function () {
      renderReports();
    });

    qsa("[data-report]").forEach(function (node) {
      node.addEventListener("click", function () {
        el("rpType").value = node.getAttribute("data-report");
      });
    });

    el("rpDownload").addEventListener("click", function () {
      window.location.href = exportUrl(el("rpType").value, el("rpFormat").value);
      toast("报表已开始下载", "success");
    });
    el("rpPreview").addEventListener("click", function () {
      window.open(exportUrl(el("rpType").value, el("rpFormat").value, true), "_blank");
    });

    var scope = el("rpScope");
    if (scope) {
      scope.textContent =
        state.range.from + " ~ " + state.range.to +
        "（" + ((state.system && state.system.timezone) || "Asia/Shanghai") + "）· " +
        (state.filterUid ? "指定用户" : state.me.identity.isAdmin ? "全部用户" : "仅我本人");
    }
    var body = el("rpScopeBody");
    if (body) {
      setHTML(body, '<div class="loading-row"><span class="spinner"></span> 正在汇总 ...</div>');
      api("/api/stats/overview?from=" + state.range.from + "&to=" + state.range.to + scopeQuery()).then(function (res) {
        if (!res.ok) {
          setHTML(body, '<div class="empty"><h4>汇总失败</h4></div>');
          return;
        }
        var t = res.totals;
        setHTML(
          body,
          '<div class="grid c4">' +
            todayStat("登录用户", fmtNum(t.loginUsers), "人", "区间内去重") +
            todayStat("日均登录", fmtNum(t.avgDailyLoginUsers), "人", "每日平均") +
            todayStat("浏览次数", fmtNum(t.views), "次", "平均单次 " + fmtDur(t.avgSecondsPerView)) +
            todayStat("总停留", fmtDur(t.seconds), "", "共 " + t.projects + " 个项目") +
            "</div>"
        );
      });
    }
  }

  /* -------------------------------------------------------------------- 设置 */

  function renderSettings() {
    if (!state.me.identity.isAdmin) {
      renderShell("#/", "概览", "无权访问设置");
      location.hash = "#/";
      return;
    }
    renderShell("#/settings", "设置", "GitHub OAuth 凭据、统计口径与外观");
    var view = el("view");
    setHTML(view, '<div class="loading-row"><span class="spinner"></span> 加载设置 ...</div>');

    Promise.all([api("/api/config"), api("/api/callback-url"), api("/api/health")]).then(function (res) {
      var cfgRes = res[0], cbRes = res[1], hRes = res[2];
      if (!cfgRes.ok) {
        setHTML(view, '<div class="empty"><h4>加载设置失败</h4><p>' + esc(cfgRes.error || "") + "</p></div>");
        return;
      }
      var c = cfgRes.config;
      var cbUrl = cbRes.ok ? cbRes.callbackUrl : "";

      setHTML(
        view,
        '<div class="card" id="oauthCard">' +
          '<div class="card-title">GitHub OAuth 应用</div>' +
          '<div class="card-desc">在 GitHub → Settings → Developer settings → OAuth Apps → New OAuth App 创建应用，把下面的回调地址填入 Authorization callback URL。</div>' +
          '<div class="copy-row" style="margin:12px 0 18px"><input class="input mono" readonly value="' + attr(cbUrl) + '" id="setCb"/>' +
          '<button class="btn sm" type="button" id="setCopyCb">复制</button></div>' +
          '<div class="form-row">' +
          '<div class="field"><label>Client ID</label><input class="input mono" id="setClientId" value="' + attr(c.oauthClientId || "") + '" placeholder="Ov23li..."/></div>' +
          '<div class="field"><label>Client Secret</label><input class="input mono" id="setClientSecret" type="password" placeholder="留空表示不修改已保存的密钥" autocomplete="off"/></div>' +
          "</div>" +
          '<div class="field"><label>对外访问地址（可选）</label>' +
          '<input class="input mono" id="setBaseUrl" value="' + attr(c.publicBaseUrl || "") + '" placeholder="https://nas.example.com 或 http://192.168.1.10:5666"/>' +
          '<span class="tip">留空时按当前浏览器地址自动推断。使用反向代理或域名访问时建议填写。</span></div>' +
          '<div class="field"><label>GitHub API 地址（可选，镜像 / 反代）</label>' +
          '<input class="input mono" id="setApiBase" value="' + attr(c.githubApiBase || "") + '" placeholder="https://api.github.com"/>' +
          '<span class="tip">NAS 无法直连 api.github.com 时，可填写可达的镜像或自建反代地址（需完整兼容 GitHub REST API）。留空使用官方地址。</span></div>' +
          '<div class="field"><label>当前状态</label><div>' +
          (c.oauthConfigured
            ? '<span class="chip ok">已配置，用户可正常登录 GitHub</span>'
            : '<span class="chip bad">未配置，用户暂时无法通过 OAuth 登录</span>') +
          "</div></div>" +
          "</div>" +
          '<div class="card">' +
          '<div class="card-title">统计与数据</div>' +
          '<div class="form-row" style="margin-top:12px">' +
          '<div class="field"><label>统计时区</label><input class="input mono" id="setTz" value="' + attr(c.timezone) + '"/>' +
          '<span class="tip">用于划分「每一天」，例如 Asia/Shanghai</span></div>' +
          '<div class="field"><label>明细数据保留天数</label><input class="input" id="setRetention" type="number" min="7" max="3650" value="' + attr(c.retentionDays) + '"/>' +
          '<span class="tip">超出天数的原始明细会被自动清理</span></div>' +
          "</div>" +
          '<div class="field"><label class="switch"><input type="checkbox" id="setPrivate"' + (c.allowPrivateRepos ? " checked" : "") + '/><span>允许用户读取自己的私有仓库（会申请 repo 权限）</span></label></div>' +
          '<div class="field"><label class="switch"><input type="checkbox" id="setShare"' + (c.exportToShare ? " checked" : "") + '/><span>导出报表时同时写入共享目录</span></label></div>' +
          '<div class="field"><label>新用户默认主题</label><select class="select" id="setTheme">' +
          '<option value="auto"' + (c.defaultTheme === "auto" ? " selected" : "") + ">跟随系统</option>" +
          (cfgRes.themes || [])
            .map(function (t) {
              return '<option value="' + attr(t.id) + '"' + (c.defaultTheme === t.id ? " selected" : "") + ">" + esc(t.name) + "（" + (t.mode === "dark" ? "深色" : "浅色") + "）</option>";
            })
            .join("") +
          "</select></div>" +
          '<div style="display:flex;gap:10px;margin-top:6px"><button class="btn primary" type="button" id="setSave">保存设置</button>' +
          '<button class="btn" type="button" id="setReload">放弃修改</button></div>' +
          "</div>" +
          '<div class="card"><div class="card-title">运行信息</div><div id="sysInfo" style="margin-top:10px"></div></div>' +
          '<div class="card"><div class="card-title">关于 GStats</div>' +
          '<div class="about-row">' +
          '<img class="about-logo" src="' + PREFIX + '/logo.png" alt="GStats"/>' +
          '<div class="about-meta">' +
          '<div class="about-name">GStats<span class="about-ver">v' + esc((hRes && hRes.version) || "1.0.0") + "</span></div>" +
          '<div class="about-desc">飞牛 fnOS 原生应用 · 本地部署的 GitHub 使用统计平台</div>' +
          '<div class="about-dev">开发者 <b>Misite齊</b> · ' +
          '<a href="https://github.com/MisiteQ" target="_blank" rel="noopener">' + icon("github") + " github.com/MisiteQ</a></div>" +
          "</div></div>" +
          '<div class="card-desc" style="margin-top:14px">数据全部保存在本机 NAS，不上传任何第三方。开源许可 MIT。</div>' +
          "</div>" +
          '<div class="card"><div class="card-title">主题色</div>' +
          '<div class="card-desc">主题保存在当前浏览器，可随时切换，不影响其他用户。</div>' +
          '<div class="theme-grid" id="themePicker" style="margin-top:12px"></div></div>'
      );

      el("setCopyCb").addEventListener("click", function () { copyText(cbUrl); });
      el("setReload").addEventListener("click", renderSettings);
      renderThemePicker();

      // 系统信息
      var info = el("sysInfo");
      if (hRes && hRes.ok) {
        var rt = hRes.runtime, dt = hRes.data;
        var rows = [
          ["应用版本", hRes.app + " v" + hRes.version],
          ["Node 运行时", rt.node],
          ["进程 PID", rt.pid],
          ["运行时长", fmtDur(rt.uptimeSeconds)],
          ["网关路径", hRes.config.gateway],
          ["数据目录", dt.dataDir],
          ["共享目录", (state.system && state.system.shareDir) || "-"],
          ["事件总数", fmtNum(dt.eventCount)],
          ["覆盖天数", fmtNum(dt.dayCount)],
          ["用户数", fmtNum(dt.userCount) + "（已关联 GitHub " + dt.linkedCount + "）"]
        ];
        setHTML(
          info,
          '<table class="mini-table" style="width:100%">' +
            rows
              .map(function (r) {
                return '<tr><td style="color:var(--text-3);white-space:nowrap;padding-right:16px">' + esc(r[0]) + "</td><td class=\"mono\" style=\"word-break:break-all\">" + esc(r[1]) + "</td></tr>";
              })
              .join("") +
            "</table>"
        );
      }

      el("setSave").addEventListener("click", function () {
        var payload = {
          githubApiBase: el("setApiBase").value.trim(),
          oauth: {
            clientId: el("setClientId").value.trim(),
            publicBaseUrl: el("setBaseUrl").value.trim()
          },
          timezone: el("setTz").value.trim(),
          retentionDays: Number(el("setRetention").value),
          allowPrivateRepos: el("setPrivate").checked,
          exportToShare: el("setShare").checked,
          defaultTheme: el("setTheme").value
        };
        var secret = el("setClientSecret").value.trim();
        if (secret) payload.oauth.clientSecret = secret;

        var btn = el("setSave");
        btn.disabled = true;
        btn.textContent = "保存中 ...";
        api("/api/config", { method: "PUT", body: payload }).then(function (r) {
          btn.disabled = false;
          btn.textContent = "保存设置";
          if (!r.ok) {
            toast(r.error || "保存失败", "error");
            return;
          }
          toast("设置已保存", "success");
          loadMe(true).then(function () {
            renderSettings();
          });
        });
      });
    }).catch(function (err) {
      setHTML(view, errorCard("设置加载失败", err && err.message ? err.message : "网络请求失败"));
      bindRetry(view);
    });
  }

  /* -------------------------------------------------------------------- 路由 */

  function route() {
    if (!state.me) return;
    var hash = location.hash || "#/";
    var parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    tracker.stop();

    if (!parts.length) {
      state.currentView = "overview";
      renderOverview();
      return;
    }
    switch (parts[0]) {
      case "github":
        state.currentView = "github";
        renderGithub();
        break;
      case "repo":
        if (parts.length >= 3) renderRepo(decodeURIComponent(parts[1]), decodeURIComponent(parts[2]));
        else location.hash = "#/github";
        break;
      case "explore":
        state.currentView = "explore";
        renderExplore();
        break;
      case "stats":
        state.currentView = "stats";
        renderStats();
        break;
      case "reports":
        state.currentView = "reports";
        renderReports();
        break;
      case "settings":
        state.currentView = "settings";
        renderSettings();
        break;
      default:
        location.hash = "#/";
    }
  }

  /* -------------------------------------------------------------------- 启动 */

  function loadMe(force) {
    return api("/api/me").then(function (res) {
      if (res.ok) {
        state.me = { identity: res.identity, github: res.github, linked: res.linked, authMethod: res.authMethod };
        state.system = res.system;
      } else if (!state.me) {
        state.me = { identity: { uid: "unknown", fnosUsername: "未知用户", isAdmin: false }, github: null, linked: false };
        state.system = state.system || {};
      }
      return state.me;
    });
  }

  function loadUsers() {
    return api("/api/users").then(function (res) {
      state.users = res.ok ? res.items : [];
    });
  }

  function handleCallbackParams() {
    var p = new URLSearchParams(location.search);
    var login = p.get("login");
    if (!login) return;
    var reason = p.get("reason") || "";
    if (login === "ok") {
      toast(p.get("linked") ? "GitHub 账号关联成功" : "GitHub 账号已更新", "success");
    } else if (login === "error") {
      toast("登录失败：" + reason, "error");
    }
    history.replaceState(null, "", location.pathname + location.hash);
  }

  function boot() {
    // 保证地址以斜杠结尾，避免相对路径解析错误
    if (PREFIX && location.pathname === PREFIX) {
      history.replaceState(null, "", PREFIX + "/" + location.search + location.hash);
    }
    applyTheme(storedTheme());
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () {
        if (storedTheme() === "auto") applyTheme("auto");
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    loadMe(true).then(function () {
      if (state.system && state.system.defaultTheme && storedTheme() === "auto" && state.system.defaultTheme !== "auto") {
        applyTheme(state.system.defaultTheme);
      }
      handleCallbackParams();
      loadUsers().then(function () {
        route();
      });
    });

    window.addEventListener("hashchange", route);

    // 概览页每 60 秒自动刷新一次
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(function () {
      if (state.currentView === "overview" && !document.hidden) renderOverviewData();
    }, 60000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
