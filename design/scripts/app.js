/**
 * app.js —— 原型交互层（原生 JS，无依赖）
 *
 * 只用浏览器原生能力实现：入场编排、状态切换、抽屉/弹窗、流式模拟、倒计时。
 * 全部动效只改 opacity / transform，且天然受 prefers-reduced-motion 约束（见 base.css）。
 */

(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------------------------------------------------------------- 入场编排 */
  /* 每个 .reveal 进入视口即错峰点亮（逐组 80ms，见 base.css） */
  function initReveal() {
    const items = $$('.reveal');
    if (!items.length) return;
    if (!('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    items.forEach((el) => io.observe(el));
  }

  /* -------------------------------------------------------------- 主题切换 */
  /* 暗色只是语义令牌覆盖，组件代码一行不动（见 tokens.css） */
  function initTheme() {
    $$('[data-theme-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const root = document.documentElement;
        const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        if (next === 'dark') root.setAttribute('data-theme', 'dark');
        else root.removeAttribute('data-theme');
        btn.setAttribute('aria-pressed', String(next === 'dark'));
        btn.textContent = next === 'dark' ? '暗色' : '浅色';
      });
    });
  }

  /* -------------------------------------------------- 列表三态（空/加载/错误） */
  /* 用分段控件切换，方便逐个状态走查（docs/03 §七「列表三态」） */
  function initStateSwitcher() {
    $$('[data-state-root]').forEach((root) => {
      const panes = $$('[data-state]', root);
      const buttons = $$('[data-state-btn]', root);
      if (!panes.length) return;

      function apply(name) {
        panes.forEach((pane) => {
          pane.hidden = pane.dataset.state !== name;
        });
        buttons.forEach((b) => {
          b.setAttribute('aria-pressed', String(b.dataset.stateBtn === name));
        });
      }

      buttons.forEach((b) => b.addEventListener('click', () => apply(b.dataset.stateBtn)));
      apply((buttons.find((b) => b.getAttribute('aria-pressed') === 'true') || buttons[0])?.dataset
        .stateBtn || panes[0].dataset.state);
    });
  }

  /* ----------------------------------------------------------- 抽屉与弹窗 */
  function closeAllLayers() {
    $$('.scrim, .drawer').forEach((el) => {
      el.hidden = true;
    });
  }

  function initLayers() {
    $$('[data-open]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const target = document.getElementById(btn.dataset.open);
        if (!target) return;
        const willOpen = target.hidden;
        /* 菜单类浮层同时只开一个；弹窗/抽屉点了就开 */
        $$('.menu').forEach((m) => {
          m.hidden = true;
        });
        target.hidden = !willOpen;
      });
    });

    $$('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeAllLayers());
    });

    /* 点击遮罩空白处关闭（面板内不关） */
    $$('.scrim, .drawer').forEach((layer) => {
      layer.addEventListener('mousedown', (event) => {
        if (event.target === layer) layer.hidden = true;
      });
    });

    /* 下拉菜单：点到别处收起 */
    document.addEventListener('click', (event) => {
      if (event.target.closest('.menu') || event.target.closest('[data-open]')) return;
      $$('.menu').forEach((m) => {
        m.hidden = true;
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAllLayers();
    });
  }

  /* ------------------------------------------------------------- 轻提示 */
  function toast(message, opts) {
    const stack = $('.toast-stack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast' + (opts?.tone ? ' toast--' + opts.tone : '');
    el.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    if (opts?.code) {
      const code = document.createElement('span');
      code.className = 'toast__code num';
      code.textContent = opts.code;
      el.appendChild(code);
    }
    stack.appendChild(el);
    window.setTimeout(() => {
      el.style.transition = 'opacity 320ms cubic-bezier(.16,1,.3,1), transform 320ms cubic-bezier(.16,1,.3,1)';
      el.style.opacity = '0';
      el.style.transform = 'translateY(10px)';
      window.setTimeout(() => el.remove(), 360);
    }, opts?.hold ?? 2600);
  }

  function initToasts() {
    $$('[data-toast]').forEach((btn) => {
      btn.addEventListener('click', () => {
        toast(btn.dataset.toast, { code: btn.dataset.code, tone: btn.dataset.tone });
      });
    });
  }

  /* --------------------------------------------------------------- 复制 */
  function initCopy() {
    $$('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const source = document.getElementById(btn.dataset.copy);
        const text = source ? source.innerText : btn.dataset.copy;
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(
            () => toast('已复制全文'),
            () => toast('复制失败，请手动选择文本', { tone: 'err' }),
          );
        } else {
          toast('当前环境不支持剪贴板，请手动选择文本');
        }
      });
    });
  }

  /* ------------------------------------------------------------- Popconfirm */
  function initPopconfirm() {
    $$('[data-pop]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const pop = document.getElementById(btn.dataset.pop);
        if (!pop) return;
        const isOpen = !pop.hidden;
        $$('.popconfirm').forEach((el) => {
          el.hidden = true;
        });
        pop.hidden = isOpen;
      });
    });
    document.addEventListener('click', () => {
      $$('.popconfirm').forEach((el) => {
        el.hidden = true;
      });
    });
  }

  /* --------------------------------------------------------------- 侧栏 */
  function initSidebar() {
    $$('[data-sidebar-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sidebar = $('.sidebar');
        if (sidebar) sidebar.classList.toggle('is-open');
      });
    });
  }

  /* ------------------------------------------------------- 对话页：流式演示 */
  /* 模拟 SSE：delta 逐字追加 → thinking 展开 → 完成后自动折叠 → 结束收口。
     目的不是"假数据"，而是让输入区状态机（idle → streaming → idle）可被逐个走查。 */
  function initChatDemo() {
    const form = $('[data-chat-demo]');
    if (!form) return;

    const textarea = $('textarea', form);
    const sendBtn = $('[data-send]', form);
    const stopBtn = $('[data-stop]', form);
    const stateLabel = $('[data-chat-state]', form);
    const box = $('.composer__box', form);
    const stream = $('.stream__inner');
    const deltaTarget = $('[data-delta-target]');
    const think = $('[data-demo-think]');
    const confirmCard = $('[data-demo-confirm]');
    const countdownEl = $('[data-countdown]');
    if (!textarea || !sendBtn || !stream) return;

    const DELTA_TEXT =
      '本次检索命中 3 篇文档，均为《内部 Agent 工作台 · 部署手册》的分片。综合来看：' +
      '沙箱并发上限由 `SANDBOX_MAX_CONCURRENCY` 控制，默认 4；超出后新会话进入排队，' +
      '`queued` 事件会带上当前位次。';
    let timer = null;
    let cursor = 0;
    let countdownTimer = null;

    function setState(name) {
      if (stateLabel) stateLabel.textContent = name;
      if (box) box.dataset.locked = String(name === 'confirm');
      textarea.disabled = name === 'confirm';
      sendBtn.hidden = name === 'streaming';
      if (stopBtn) stopBtn.hidden = name !== 'streaming';
      sendBtn.disabled = name === 'confirm';
    }

    function finish() {
      window.clearInterval(timer);
      timer = null;
      $$('.caret').forEach((c) => c.remove());
      setState('idle');
      stream.scrollIntoView({ block: 'nearest' });
    }

    function startStream() {
      setState('streaming');
      if (think) think.open = true;
      if (deltaTarget) deltaTarget.textContent = '';
      cursor = 0;

      timer = window.setInterval(() => {
        if (!deltaTarget) return;
        cursor += 2;
        deltaTarget.textContent = DELTA_TEXT.slice(0, cursor);
        stream.scrollIntoView({ block: 'nearest' });
        if (cursor >= DELTA_TEXT.length) {
          /* 完成即自动折叠思考块（docs/03 §4.1） */
          if (think) think.open = false;
          finish();
          toast('本轮生成完成', { code: 'COMPLETE' });
        }
      }, 28);
    }

    sendBtn.addEventListener('click', (event) => {
      event.preventDefault();
      const userMsg = $('[data-demo-user]');
      if (userMsg && textarea.value.trim()) userMsg.textContent = textarea.value.trim();
      startStream();
    });

    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        /* 停止时序：发 /stop → 等 done{STOPPED} → 5s 未收口才 abort。
           原型里用 1.2s 模拟"收口窗口"，期间已生成的 delta 必须保留。 */
        stopBtn.disabled = true;
        stopBtn.textContent = '停止中…';
        window.setTimeout(() => {
          window.clearInterval(timer);
          timer = null;
          $$('.caret').forEach((c) => c.remove());
          setState('idle');
          stopBtn.disabled = false;
          stopBtn.textContent = '停止';
          const badge = $('[data-stopped-badge]');
          if (badge) badge.hidden = false;
          toast('已停止，本次已生成内容保留', { code: 'STOPPED', tone: 'ok' });
        }, 1200);
      });
    }

    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendBtn.click();
      }
    });

    /* 确认卡：到达即锁输入 + 120s 倒计时，取消后解锁 */
    if (confirmCard && countdownEl) {
      function startCountdown() {
        let left = 120;
        window.clearInterval(countdownTimer);
        countdownTimer = window.setInterval(() => {
          left -= 1;
          countdownEl.textContent = String(left) + 's';
          if (left <= 0) {
            window.clearInterval(countdownTimer);
            countdownEl.textContent = '已超时';
          }
        }, 1000);
      }
      $$('[data-confirm-open]').forEach((b) =>
        b.addEventListener('click', () => {
          confirmCard.hidden = false;
          setState('confirm');
          startCountdown();
          confirmCard.scrollIntoView({ block: 'nearest' });
        }),
      );
      $$('[data-confirm-close]').forEach((b) =>
        b.addEventListener('click', () => {
          confirmCard.hidden = true;
          window.clearInterval(countdownTimer);
          if (countdownEl) countdownEl.textContent = '120s';
          setState('idle');
        }),
      );
    }

    setState('idle');
  }

  /* --------------------------------------------------------- 断线 / 冲突演示 */
  function initChatChaos() {
    $$('[data-offline-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bar = $('.offline-bar');
        if (!bar) return;
        bar.hidden = !bar.hidden;
      });
    });
    $$('[data-offline-bar]').forEach((bar) => {
      bar.addEventListener('click', () => {
        bar.hidden = true;
        toast('已重新拉取历史并与后端对齐', { tone: 'ok' });
      });
    });
  }

  /* ------------------------------------------------------------- 初始化 */
  function init() {
    initReveal();
    initTheme();
    initStateSwitcher();
    initLayers();
    initToasts();
    initCopy();
    initPopconfirm();
    initSidebar();
    initChatDemo();
    initChatChaos();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
