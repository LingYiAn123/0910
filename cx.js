// ==UserScript==
// @name         🥇超星学习通网课小助手|精简修复版(路由/视频暂停/弹题自动作答)
// @namespace    noshuang
// @version      0.4.5
// @author       Modified
// @description  修复手动切换页面卡死；视频/音频自动静音播放，PPT/PDF 自动翻阅；非弹题暂停 3 秒恢复；视频内弹题不绕过——弹窗打开期间绝不自动恢复播放，由脚本自动作答（支持 window.__CX_AUTO_ANSWER 配置题库/自定义 provider，默认排除法试答），弹窗关闭后才继续播放；章节级习题仍跳过。
// @match        https://mooc1.chaoxing.com/mycourse/studentstudy*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window.self) return;

    /* ================= 日志面板 ================= */
    const Logger = (() => {
        const container = document.createElement('div');
        container.style.cssText = 'position:fixed;top:150px;right:20px;width:320px;background:#fff;border-radius:8px;box-shadow:0 6px 16px rgba(0,0,0,0.15);z-index:999999;font-size:13px;font-family:sans-serif;overflow:hidden;border:1px solid #ebeef5;';

        const header = document.createElement('div');
        header.style.cssText = 'background:#1f71e0;color:#fff;padding:12px 15px;font-weight:bold;cursor:move;user-select:none;display:flex;justify-content:space-between;align-items:center;';
        header.innerHTML = `<span>任务监控中</span><span style="font-size:10px;background:rgba(255,255,255,0.2);padding:2px 6px;border-radius:4px;">PRO-MINI</span>`;

        const logArea = document.createElement('div');
        logArea.style.cssText = 'padding:12px;height:280px;overflow-y:auto;background:#fafafa;';

        container.appendChild(header);
        container.appendChild(logArea);
        document.body.appendChild(container);

        let isDragging = false, offsetX, offsetY;
        header.onmousedown = (e) => { isDragging = true; offsetX = e.clientX - container.offsetLeft; offsetY = e.clientY - container.offsetTop; };
        document.onmousemove = (e) => { if (isDragging) { container.style.left = (e.clientX - offsetX) + 'px'; container.style.top = (e.clientY - offsetY) + 'px'; container.style.right = 'auto'; } };
        document.onmouseup = () => isDragging = false;

        const colors = { primary: '#409EFF', success: '#67C23A', warning: '#E6A23C', danger: '#F56C6C' };

        return {
            addLog: (msg, type = 'primary') => {
                try {
                    const time = new Date().toLocaleTimeString();
                    const p = document.createElement('div');
                    p.style.cssText = `margin-bottom:10px;line-height:1.5;border-bottom:1px dashed #eee;padding-bottom:5px;`;
                    p.innerHTML = `<span style="color:#999;font-size:11px;margin-right:8px;">[${time}]</span><span style="color:${colors[type] || colors.primary};font-weight:500;">${msg.replace(/</g, '&lt;')}</span>`;
                    logArea.appendChild(p);
                    logArea.scrollTop = logArea.scrollHeight;
                } catch (e) {}
            }
        };
    })();

    const sleep = (sec) => new Promise(resolve => setTimeout(resolve, sec * 1000));

    /* ================= 通用 DOM 工具 ================= */
    const normalizeText = (t) => (t || '')
        .replace(/^[A-Ha-h][.、:：)]\s*/, '')
        .replace(/[\t\u00a0\u2002\u2003\u3000]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const isVisible = (el) => {
        try {
            if (!el || !el.getClientRects) return false;
            if (el.getClientRects().length === 0 && !el.offsetParent) return false;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            return true;
        } catch (e) { return false; }
    };

    const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    // 模拟人工单击：mousedown/mouseup + 单次 click()。
    // 关键：绝不补发第二个合成 click —— label 先被 click() 勾上、再被补发 click 取消 = 等于没选（之前多选全错的根因）。
    const clickEl = (el) => {
        try {
            const r = el.getBoundingClientRect();
            const w = Math.max(1, Math.round(r.width));
            const h = Math.max(1, Math.round(r.height));
            const x = r.left + randInt(2, Math.max(3, w - 2));
            const y = r.top + randInt(2, Math.max(3, h - 2));
            const base = { bubbles: true, cancelable: true, view: el.ownerDocument && el.ownerDocument.defaultView, clientX: x, clientY: y, button: 0 };
            el.dispatchEvent(new MouseEvent('mousedown', base));
            el.dispatchEvent(new MouseEvent('mouseup', base));
            el.click();
        } catch (e) {
            try { el.click(); } catch (_) {}
        }
    };

    const selectPicks = async (doc, picks, isMulti) => {
        try {
            const pickTexts = new Set(picks.map(p => normalizeText(p.text)));
            const inputs = Array.from(doc.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
            const clickableOf = (el) => {
                try { return el.closest('.ans-videoquiz-opt, .ans-cc, label, li, [class*="option" i]') || el; } catch (e) { return el; }
            };

            // 1) 多选：先取消已勾选项（模拟人工清空，防选项累积）
            if (isMulti) {
                for (const inp of inputs) {
                    if (!inp.checked) continue;
                    clickEl(clickableOf(inp));
                    await sleep(randInt(15, 35) / 100);
                }
            }

            // 2) 逐个点击目标选项，带人工节奏
            for (const p of picks) {
                const root = clickableOf(p.el);
                clickEl(root);
                await sleep(randInt(30, 60) / 100);
                const inp = root.querySelector ? root.querySelector('input[type="checkbox"], input[type="radio"]') : null;
                if (inp && !inp.checked) {
                    clickEl(inp); // 容器点击未被识别时，直接点 input
                    await sleep(randInt(20, 40) / 100);
                }
            }

            // 3) 最终校验：勾选状态必须与目标一致（仍优先走点击路径，极端情况才强设）
            for (const inp of inputs) {
                const holder = inp.closest('.ans-videoquiz-opt, label, li, [class*="option" i]') || inp.parentElement;
                const hText = holder ? normalizeText(holder.textContent) : '';
                if (!hText) continue;
                const want = [...pickTexts].some(t => hText.includes(t) || t.includes(hText));
                if (!!inp.checked !== want) {
                    clickEl(clickableOf(inp)); // 先按交互路径再点一次
                    await sleep(randInt(20, 35) / 100);
                    if (!!inp.checked !== want) {
                        try {
                            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
                            setter.call(inp, want);
                            inp.dispatchEvent(new Event('change', { bubbles: true }));
                            inp.dispatchEvent(new Event('input', { bubbles: true }));
                        } catch (e) { inp.checked = want; }
                    }
                }
            }
        } catch (e) {}
    };

    const classStr = (el) => {
        try {
            const c = el.className;
            return typeof c === 'string' ? c : (c && c.baseVal) || '';
        } catch (e) { return ''; }
    };

    const styleColorStr = (el) => {
        try { return getComputedStyle(el).color || ''; } catch (e) { return ''; }
    };

    const isWrongMarked = (el) => {
        const cls = classStr(el);
        if (/wrong|error|incorrect|marking_wrong|answer_wrong|fail|jia_error|cuowu/i.test(cls)) return true;
        const c = styleColorStr(el);
        return /(255|250|240|220|204|200),\s*(0|2[0-9]|3[0-9]|4[0-9]|5[0-9]|6[0-9]),\s*0/i.test(c);
    };

    const isCorrectMarked = (el) => {
        const cls = classStr(el);
        if (/correct|right|success|marking_right|right_answer|dui|true/i.test(cls)) return true;
        try {
            const da = (el.getAttribute('data-answer') || el.getAttribute('data-correct') || el.getAttribute('isanswer') || '').toLowerCase();
            if (['1', 'true', 'yes', 'correct', 'right', 'y'].includes(da)) return true;
        } catch (e) {}
        const c = styleColorStr(el);
        return /0,\s*(1[0-9]{2}|2[0-9]{2}),\s*0/i.test(c);
    };

    /* ================= 弹题/问卷弹窗检测（穿透 iframe 链） ================= */
    const findQuizOverlay = (doc) => {
        try {
            // 超星页面源码中的两类阻塞弹窗：自定义弹窗（视频弹题）与问卷/投票
            const custom = doc.querySelector('.customMaskDiv');
            if (custom && isVisible(custom)) {
                const frame = doc.querySelector('#popFrameId');
                const src = frame && frame.getAttribute('src') || '';
                if (src && !/about:blank/i.test(src)) {
                    return { desc: '视频弹题(自定义弹窗)', el: custom, doc };
                }
            }
            const vote = doc.querySelector('.voteContainer');
            if (vote && isVisible(vote)) {
                const vf = doc.querySelector('#voteIframe');
                const src = vf && vf.getAttribute('src') || '';
                if (src && !/about:blank/i.test(src)) {
                    return { desc: '视频内问卷/投票', el: vote, doc };
                }
            }

            // 视频 iframe 内的弹题容器（超星典型结构：.ans-videoquiz + #videoquiz-submit）
            const videoQuiz = doc.querySelector('.ans-videoquiz');
            if (videoQuiz && isVisible(videoQuiz)) {
                return { desc: '视频内弹题(ans-videoquiz)', el: videoQuiz, doc };
            }

            // 通用兜底：高 z-index 且包含答题元素/答题文字的可见浮层
            const candidates = doc.querySelectorAll(
                '[class*="question" i], [class*="quiz" i], [class*="dialog" i], [class*="modal" i], [class*="popup" i], [class*="pop" i], [id*="question" i], [id*="quiz" i], [class*="mask" i]'
            );
            for (const el of candidates) {
                if (!isVisible(el)) continue;
                const style = getComputedStyle(el);
                const highZ = parseInt(style.zIndex || '0', 10) >= 900;
                const pos = style.position === 'fixed' || style.position === 'absolute';
                if (!highZ && !pos) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width < 120 || rect.height < 80) continue;
                const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
                if (!(rect.left <= cx && rect.right >= cx && rect.top <= cy && rect.bottom >= cy)) continue;

                const quizText = /选择|单选|多选|判断|作答|答题|题目|问卷|投票|请回答|请作答/.test(el.textContent || '');
                const strong = el.querySelector('input[type="radio"], input[type="checkbox"], .ans-question, [class*="option" i], [class*="answer" i]');
                if (strong || quizText) {
                    return { desc: '媒体文档内答题浮层', el, doc };
                }
            }
        } catch (e) {}
        return null;
    };

    const findQuizOverlayInChain = (startDoc) => {
        let doc = startDoc;
        let depth = 0;
        while (doc && depth++ < 10) {
            const hit = findQuizOverlay(doc);
            if (hit) return hit;
            try {
                const frame = doc.defaultView && doc.defaultView.frameElement;
                doc = frame ? frame.ownerDocument : null;
            } catch (e) { doc = null; }
        }
        return null;
    };

    const isAnyQuizBlocked = () => {
        const stack = [document];
        const seen = new Set();
        while (stack.length) {
            const d = stack.pop();
            if (!d || seen.has(d)) continue;
            seen.add(d);
            const hit = findQuizOverlay(d);
            if (hit) return hit;
            try {
                for (const f of d.querySelectorAll('iframe')) {
                    if (f.contentDocument && f.contentDocument !== d) stack.push(f.contentDocument);
                }
            } catch (e) {}
        }
        return null;
    };

    /* ================= 弹题自动作答 ================= */
    const resolvePopupDoc = (blocked) => {
        try {
            const d = blocked.doc;
            let frame = d.querySelector('#popFrameId') || d.querySelector('#voteIframe');
            if (!frame && /popFrameId|voteIframe/.test(blocked.el.id || '')) frame = blocked.el;
            if (frame) {
                const innerDoc = frame.contentDocument;
                if (!innerDoc || !innerDoc.body) return null;
                return { doc: innerDoc, rootEl: innerDoc.body };
            }
            const root = blocked.el && blocked.el.nodeType === 1 ? blocked.el : d.body;
            return { doc: d, rootEl: root };
        } catch (e) {
            return null; // 跨域 iframe 无法访问
        }
    };

    const overlayKey = (blocked) => {
        let src = '';
        try {
            const f = blocked.doc.querySelector('#popFrameId') || blocked.doc.querySelector('#voteIframe');
            if (f) src = f.getAttribute('src') || '';
        } catch (e) {}
        return `${blocked.desc}|${blocked.el.id || ''}|${classStr(blocked.el)}|${src}`;
    };

    const eachDoc = (doc, rootEl, cb) => {
        const seen = new Set();
        const walk = (d, r) => {
            if (!d || seen.has(d)) return;
            seen.add(d);
            try { cb(d, r || d.body); } catch (e) {}
            try {
                for (const f of d.querySelectorAll('iframe')) {
                    if (f.contentDocument && f.contentDocument !== d) walk(f.contentDocument, f.contentDocument.body);
                }
            } catch (e) {}
        };
        walk(doc, rootEl || doc);
    };

    const collectOptions = (doc, rootEl) => {
        const seen = new Set();
        const out = [];
        const add = (el) => {
            try {
                if (!isVisible(el)) return;
                const text = normalizeText(el.textContent);
                if (!text || text.length > 80) return;
                if (seen.has(text)) return;
                seen.add(text);
                out.push({ el, text });
            } catch (e) {}
        };
        eachDoc(doc, rootEl, (root) => {
            try {
                root.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(inp => {
                    const holder = inp.closest('label, li, .ans-cc, [class*="option" i], .choice, .marking_choice, .topic_option, .optionItem, .selectItem, .itemRow') || inp;
                    add(holder);
                });
                // 显式选项容器：不依赖 input，避免“部分选项有 input、部分没有”时漏采（如 WDM 丢失）
                root.querySelectorAll('.ans-videoquiz-opt label, .ans-videoquiz label, .ans-cc, .answerOption, .queOption, [class*="option" i], .choice, .marking_choice, .topic_option, .optionItem, .selectItem, .itemRow, .stem_answer, .subject_option, li.topic_item, .optionList li, .answerList li, .marking_choice li, .topicOptionDiv, .singleOption, .choiceItem, .selectOption').forEach(add);
            } catch (e) {}
        });
        return out;
    };

    const findJudgeButtons = (doc, rootEl) => {
        const out = [];
        const judgeValues = ['对', '正确', '√', '是', '错', '错误', '×', '否', 'T', 'F'];
        eachDoc(doc, rootEl, (root) => {
            try {
                root.querySelectorAll('button, a, .jb_btn, [class*="btn" i], input[type="button"]').forEach(el => {
                    if (!isVisible(el)) return;
                    const t = normalizeText(el.textContent);
                    if (!t || t.length > 6) return;
                    if (judgeValues.includes(t)) out.push({ el, text: t });
                });
            } catch (e) {}
        });
        return out;
    };

    const findFillInputs = (doc, rootEl) => {
        const res = [];
        eachDoc(doc, rootEl, (root) => {
            try {
                root.querySelectorAll('input[type="text"], input:not([type]), textarea').forEach(el => {
                    if (isVisible(el)) res.push(el);
                });
            } catch (e) {}
        });
        return res;
    };

    const setNativeValue = (el, value) => {
        try {
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {}
    };

    const findBtnByText = (doc, rootEl, texts) => {
        let hit = null;
        eachDoc(doc, rootEl, (root) => {
            if (hit) return;
            try {
                for (const el of root.querySelectorAll('button, input[type="button"], input[type="submit"], a, .jb_btn, .btn, [class*="submit" i], [class*="confirm" i], [id*="submit" i], [id*="confirm" i]')) {
                    if (!isVisible(el)) continue;
                    const t = normalizeText(el.textContent);
                    if (texts.some(x => t.includes(x))) { hit = el; return; }
                }
            } catch (e) {}
        });
        return hit;
    };
    const findSubmitBtn = (doc, rootEl) => findBtnByText(doc, rootEl, ['提交', '交卷', '确定', '下一题', '保存']);
    const findCloseBtn = (doc, rootEl) => findBtnByText(doc, rootEl, ['继续', '知道了', '关闭', '完成', '确定']);

    const findQuestionEl = (doc, rootEl) => {
        let q = null;
        eachDoc(doc, rootEl, (root) => {
            if (q) return;
            try {
                const found = root.querySelector('.questionTitle, .question-content, .question_content, .qtContent, .stem, .ti, [class*="questionTitle" i], [class*="question-content" i], [class*="stem" i], h4, .subject_describe, .subject_stem, .marking_title, .queStem, .questionStem, [class*="stemTitle" i]');
                if (found) q = found;
            } catch (e) {}
        });
        return q || rootEl || doc.body;
    };
    const getQuestionText = (el) => normalizeText((el && el.textContent || '').slice(0, 300));

    const isMultiChoice = (doc) => {
        try {
            if (doc.querySelector('input[type="checkbox"]')) return true;
            const vq = doc.querySelector('.ans-videoquiz');
            if (vq && /多选题|多选|多项选择|以下哪些|以下哪几项/.test((vq.textContent || '').slice(0, 300))) return true;
        } catch (e) {}
        return false;
    };

    const getConfiguredAnswer = async (qText, options) => {
        const cfg = window.__CX_AUTO_ANSWER || {};
        if (cfg.answers) {
            const qn = qText.replace(/\s+/g, '');
            for (const key of Object.keys(cfg.answers)) {
                const kn = key.replace(/\s+/g, '');
                if (qn.includes(kn) || kn.includes(qn) || qn === kn) {
                    const v = cfg.answers[key];
                    return Array.isArray(v) ? v.map(String) : [String(v)];
                }
            }
        }
        if (typeof cfg.provider === 'function') {
            try {
                const ans = await cfg.provider(qText, options.map(o => o.text));
                if (ans) return Array.isArray(ans) ? ans.map(String) : [String(ans)];
            } catch (e) {
                Logger.addLog('自定义答题 provider 出错: ' + (e && e.message || e), 'danger');
            }
        }
        return null;
    };

    const matchAnswer = (option, ans) => {
        const t = normalizeText(option.text);
        const a = normalizeText(String(ans));
        if (t === a) return true;
        if (/^[A-Ha-h]$/.test(a)) {
            const letter = t.match(/^([A-Ha-h])[.、:：)]/);
            return !!(letter && letter[1].toUpperCase() === a.toUpperCase());
        }
        return t.includes(a) || a.includes(t);
    };

    const combinations = (arr, k) => {
        const res = [];
        const pick = (start, cur) => {
            if (cur.length === k) { res.push(cur.slice()); return; }
            for (let i = start; i < arr.length; i++) {
                cur.push(arr[i]);
                pick(i + 1, cur);
                cur.pop();
            }
        };
        pick(0, []);
        return res;
    };

    const determinePicks = async (ctx, state, qText) => {
        const { doc, rootEl } = ctx;
        const options = collectOptions(doc, rootEl);
        const judge = options.length ? [] : findJudgeButtons(doc, rootEl);
        const fills = findFillInputs(doc, rootEl);
        const configured = await getConfiguredAnswer(qText, options.concat(judge));

        if (configured) {
            const picks = (options.length ? options : judge).filter(o => configured.some(a => matchAnswer(o, a)));
            if (picks.length) return { picks, fills: [] };
            if (fills.length && configured.length) {
                fills.slice(0, configured.length).forEach((el, i) => setNativeValue(el, configured[i]));
                return { picks: [], fills };
            }
        }

        if (options.length) {
            const markedCorrect = options.filter(o => isCorrectMarked(o.el) && !state.wrong.has(o.text));
            if (markedCorrect.length) {
                markedCorrect.forEach(o => state.tried.add(o.text));
                return { picks: markedCorrect, fills: [] };
            }
            const isMulti = isMultiChoice(doc);
            if (isMulti) {
                if (state.fullCycleDone) {
                    return { picks: [], fills: [], reason: '全部组合已尝试完毕，请配置答案' };
                }
                const cands = options.filter(o => !state.wrong.has(o.text));
                const keyNow = cands.map(c => c.text).sort().join('|');
                // 缓存全量组合并按序推进（跨轮次用 comboIndex 续走），不再每次重新洗牌
                if (!state.combosKey || state.combosKey !== keyNow) {
                    state.combos = [];
                    const n = cands.length;
                    const maxSize = n > 8 ? Math.min(4, n) : n;
                    for (let size = 1; size <= maxSize; size++) {
                        for (const combo of combinations(cands, size)) {
                            state.combos.push(combo);
                        }
                    }
                    if (n > 8) state.combos.push(cands.slice()); // 全选兜底
                    state.combosKey = keyNow;
                    state.comboIndex = 0;
                    state.tried.clear();
                    state.fullCycleDone = false;
                    state.cycleLogAt = 0;
                    Logger.addLog(
                        n > 8
                            ? `多选题选项较多(${n}个)，枚举 1~4 项及全选（${state.combos.length} 种），建议配置答案`
                            : `多选题共 ${state.combos.length} 种组合，将按序尝试`,
                        'primary'
                    );
                }
                let pick = null;
                while (state.comboIndex < state.combos.length) {
                    const combo = state.combos[state.comboIndex++];
                    const key = combo.map(c => c.text).sort().join('|');
                    if (!state.tried.has(key)) {
                        state.tried.add(key);
                        pick = combo;
                        break;
                    }
                }
                // 全量组合已彻底穷尽：停止试错（避免 5/6 选项 63 种组合无限重试），等待配置答案
                if (!pick && state.combos.length) {
                    state.fullCycleDone = true;
                    state.comboIndex = 0;
                    state.tried.clear();
                    return { picks: [], fills: [], reason: '全部组合已尝试完毕，请配置答案' };
                }
                if (pick) {
                    // 用最新 DOM 元素映射，避免容器重绘后旧节点失效
                    const fresh = pick.map(p => options.find(o => o.text === p.text) || p);
                    return { picks: fresh, fills: [] };
                }
            } else {
                const cand = options.find(o => !state.tried.has(o.text) && !state.wrong.has(o.text));
                if (cand) {
                    state.tried.add(cand.text);
                    return { picks: [cand], fills: [] };
                }
                // 试尽后重置尝试记录（保留已判错选项），避免同一弹题卡死
                if (state.tried.size) {
                    state.tried.clear();
                    const retry = options.find(o => !state.wrong.has(o.text));
                    if (retry) {
                        state.tried.add(retry.text);
                        return { picks: [retry], fills: [] };
                    }
                }
            }
        }
        if (judge.length) {
            const cand = judge.find(o => !state.tried.has(o.text) && !state.wrong.has(o.text));
            if (cand) {
                state.tried.add(cand.text);
                return { picks: [cand], fills: [] };
            }
            if (state.tried.size) {
                state.tried.clear();
                const retry = judge.find(o => !state.wrong.has(o.text));
                if (retry) {
                    state.tried.add(retry.text);
                    return { picks: [retry], fills: [] };
                }
            }
        }
        return { picks: [], fills: [], reason: '未找到可作答的选项/输入框' };
    };

    /**
     * 自动作答一轮弹题。返回 true 表示弹窗已关闭。
     * 策略：配置答案（map/provider） > 选项上的正确标记 > 默认排除法试答；
     * 多选题使用有限组合枚举；判断题识别“对/错”按钮；填空依赖配置答案。
     */
    const answerPopupOnce = async (blocked, ctx, state) => {
        const { doc, rootEl } = ctx;

        // 全量组合已试完：不再刷屏重试，仅节流提示（不强制恢复播放）
        if (state.fullCycleDone) {
            const nowL = Date.now();
            if (!state.cycleLogAt || nowL - state.cycleLogAt >= 30000) {
                state.cycleLogAt = nowL;
                Logger.addLog('该多选题全部组合已尝试仍未答对。请配置 window.__CX_AUTO_ANSWER.answers 后刷新，或手动完成（弹窗不会自动关闭、不会强制恢复播放）', 'danger');
            }
            return false;
        }

        const qEl = findQuestionEl(doc, rootEl);
        const qText = getQuestionText(qEl);
        Logger.addLog(`自动作答弹题：${qText.slice(0, 50) || '(未识别题干)'}`, 'warning');

        let contentReady = false;
        for (let i = 0; i < 75; i++) {
            if (collectOptions(doc, rootEl).length || findJudgeButtons(doc, rootEl).length || findFillInputs(doc, rootEl).length
                || doc.querySelector('.ans-videoquiz-opt label, .ans-videoquiz label')) {
                contentReady = true;
                break;
            }
            if (i % 10 === 9) Logger.addLog('等待弹题内容加载...', 'primary');
            await sleep(0.2);
        }
        if (!contentReady) {
            Logger.addLog('弹题内容未加载或跨域不可访问', 'danger');
            return false;
        }

        const options = collectOptions(doc, rootEl);
        const isMulti = isMultiChoice(doc);
        // 多选题：给足轮次推进全量组合（选项更多时跨多轮继续，不会中途洗牌重来）
        const maxAttempts = isMulti
            ? Math.min(30, Math.max(10, (options.length || 2) * 5)) // 5选项25次/轮、6选项30次/轮，跨轮续走
            : Math.min(14, Math.max(6, (options.length || 2) * 2 + 1));

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (!findQuizOverlayInChain(blocked.doc)) return true;

            const res = await determinePicks(ctx, state, qText);
            if (res.picks.length === 0 && !(res.fills && res.fills.length)) {
                // 全量组合试完后的提示做节流，避免每 2.5 秒刷屏
                const nowLog = Date.now();
                if (res.reason === '全部组合已尝试完毕，请配置答案' && state.cycleLogAt && nowLog - state.cycleLogAt < 30000) {
                    return false;
                }
                state.cycleLogAt = nowLog;
                Logger.addLog(`自动作答失败：${res.reason || '无可用选项'}（第 ${attempt} 次）`, 'danger');
                return false;
            }
            if (res.picks.length) {
                Logger.addLog(`弹题第 ${attempt} 次选择：${res.picks.map(p => p.text).join('、')}`, 'primary');
                await selectPicks(doc, res.picks, isMulti); // 模拟人工勾选：清空→逐个点→校验
                await sleep(randInt(30, 60) / 100);
            }
            const submit = findSubmitBtn(doc, rootEl);
            if (submit) clickEl(submit);
            await sleep(randInt(18, 25) / 10); // 1.8~2.5s 人工反馈等待

            if (!findQuizOverlayInChain(blocked.doc)) {
                Logger.addLog('弹题作答完成，弹窗已关闭', 'success');
                return true;
            }

            // 视频弹题答对判定：容器出现“恭喜你，答对了！/继续学习” → 点继续并清理（非绕过，是作答完成后的正常流程）
            const vq = doc.querySelector('.ans-videoquiz');
            if (vq) {
                const vqText = (vq.innerText || vq.textContent || '');
                if (vqText.indexOf('恭喜你，答对了！') !== -1 || vqText.indexOf('继续学习') !== -1) {
                    const btn = Array.prototype.slice.call(vq.querySelectorAll('a, button, span, div')).find((el) => {
                        const tt = (el.innerText || el.textContent || '').trim();
                        return tt === '继续学习' || tt.indexOf('继续') !== -1;
                    });
                    if (btn) clickEl(btn);
                    await sleep(0.8);
                    try { if (vq.parentNode) vq.parentNode.removeChild(vq); } catch (e) {}
                    Logger.addLog('弹题作答完成（答对），弹窗已关闭', 'success');
                    return true;
                }
            }

            // 收集作答后的反馈标记（红=错，绿=对）
            for (const o of collectOptions(doc, rootEl)) {
                if (isWrongMarked(o.el)) state.wrong.add(o.text);
                if (isCorrectMarked(o.el)) state.correct.add(o.text);
            }
            // 已给出正确标记但弹窗仍开 → 点击“继续/确定/关闭”
            const correctPicks = collectOptions(doc, rootEl).filter(o => isCorrectMarked(o.el));
            if (correctPicks.length) {
                const close = findCloseBtn(doc, rootEl);
                if (close) {
                    clickEl(close);
                    await sleep(1.2);
                    if (!findQuizOverlayInChain(blocked.doc)) {
                        Logger.addLog('弹题作答完成，弹窗已关闭', 'success');
                        return true;
                    }
                }
            }
        }
        Logger.addLog('自动作答达到尝试上限，弹窗仍未关闭（不会强制恢复播放）', 'danger');
        return false;
    };

    const AnswerBot = {
        working: false,
        lastRun: 0,
        currentKey: '',
        triedMap: new Map(),
        wrongMap: new Map(),
        qTextMap: new Map(),
        stateMap: new Map(),
        async start(blocked) {
            const key = overlayKey(blocked);
            if (key !== this.currentKey) {
                this.currentKey = key;
                if (!this.triedMap.has(key)) this.triedMap.set(key, new Set());
                if (!this.wrongMap.has(key)) this.wrongMap.set(key, new Set());
            }
            this.working = true;
            try {
                const ctx = resolvePopupDoc(blocked);
                if (!ctx) {
                    Logger.addLog('弹题窗口跨域不可访问，无法自动作答（不会强制恢复播放）', 'danger');
                    return;
                }
                // 同一弹窗地址内换了新题 → 重置本题的尝试/判错/组合进度
                const qEl = findQuestionEl(ctx.doc, ctx.rootEl);
                const qText = getQuestionText(qEl);
                const prevQ = this.qTextMap.get(key);
                if (prevQ && qText && prevQ !== qText) {
                    this.triedMap.set(key, new Set());
                    this.wrongMap.set(key, new Set());
                    this.stateMap.delete(key);
                }
                if (qText) this.qTextMap.set(key, qText);

                // state 跨轮持久：多选题的组合枚举进度(algo combos/comboIndex)不会每轮重来
                let state = this.stateMap.get(key);
                if (!state) {
                    state = {
                        tried: this.triedMap.get(key),
                        wrong: this.wrongMap.get(key),
                        correct: new Set(),
                        combos: null,
                        combosKey: '',
                        comboIndex: 0,
                        fullCycleDone: false,
                        cycleLogAt: 0
                    };
                    this.stateMap.set(key, state);
                } else {
                    state.tried = this.triedMap.get(key);
                    state.wrong = this.wrongMap.get(key);
                }

                const ok = await answerPopupOnce(blocked, ctx, state);
                if (ok) {
                    this.currentKey = '';
                    this.stateMap.delete(key);
                    this.triedMap.delete(key);
                    this.wrongMap.delete(key);
                    this.qTextMap.delete(key);
                }
            } catch (e) {
                Logger.addLog('自动作答异常：' + (e && e.message || e), 'danger');
            } finally {
                this.working = false;
                this.lastRun = Date.now();
            }
        }
    };

    /* ================= 播放恢复（弹题期间绝不 resume） ================= */
    const quizWaitCleanupMap = new WeakMap();

    const stopQuizWait = (media) => {
        const cleanup = quizWaitCleanupMap.get(media);
        if (cleanup) { try { cleanup(); } catch (e) {} quizWaitCleanupMap.delete(media); }
    };

    const startQuizWait = (media, mediaDoc, mediaWin) => {
        stopQuizWait(media);
        let timer = null;
        let lastLog = 0;
        const cleanup = () => { if (timer) clearInterval(timer); timer = null; };
        quizWaitCleanupMap.set(media, cleanup);

        const attemptPlay = () => {
            try {
                media.muted = true;
                const p = media.play();
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (e) {}
            try {
                if (mediaWin && mediaWin.videojs) {
                    const player = mediaWin.videojs('video') || mediaWin.videojs(media);
                    if (player && typeof player.play === 'function') {
                        const p = player.play();
                        if (p && typeof p.catch === 'function') p.catch(() => {});
                    }
                }
            } catch (e) {}
        };

        const tick = () => {
            if (!media || media.ended || !media.paused) { cleanup(); return; }
            const blocked = findQuizOverlayInChain(mediaDoc);
            if (!blocked) {
                cleanup();
                Logger.addLog('弹题已完成，自动恢复播放', 'success');
                attemptPlay();
                return;
            }
            const now = Date.now();
            if (now - lastLog > 20000) {
                lastLog = now;
                Logger.addLog(`答题弹窗仍开启（${blocked.desc}），自动作答中/等待弹窗关闭，暂不恢复播放`, 'warning');
            }
            if (!AnswerBot.working && now - AnswerBot.lastRun > 2500) {
                AnswerBot.start(blocked);
            }
        };

        timer = setInterval(tick, 500);
        tick();
    };

    const processMedia = (mediaType, iframeDocument, iframeWindow) => new Promise((resolve) => {
        Logger.addLog(`正在加载 ${mediaType} 资源...`, 'primary');
        let retryCount = 0;
        let resolved = false;

        const finish = (media, msg) => {
            if (resolved) return;
            resolved = true;
            stopQuizWait(media);
            Logger.addLog(msg || `${mediaType} 播放完毕`, 'success');
            resolve();
        };

        const checkAndPlay = setInterval(() => {
            const media = iframeDocument.documentElement.querySelector(mediaType);
            if (!media) {
                if (retryCount++ > 60) {
                    clearInterval(checkAndPlay);
                    if (!resolved) { resolved = true; resolve(); }
                }
                return;
            }
            clearInterval(checkAndPlay);
            Logger.addLog(`${mediaType} 解析成功，开始静音播放`, 'primary');
            media.muted = true;

            let resumeTimer = null;
            let benignAttempts = 0;

            const scheduleResume = () => {
                clearTimeout(resumeTimer);
                resumeTimer = setTimeout(() => {
                    if (!media || media.ended || !media.paused) return;
                    const blocked = findQuizOverlayInChain(iframeDocument);
                    if (blocked) {
                        Logger.addLog(`检测到弹题（${blocked.desc}），暂停自动恢复，转自动作答`, 'warning');
                        startQuizWait(media, iframeDocument, iframeWindow);
                        return;
                    }
                    benignAttempts++;
                    if (benignAttempts > 3) {
                        Logger.addLog('持续恢复播放失败，请点击页面任意处（弹题等待逻辑不受影响）', 'danger');
                        return;
                    }
                    Logger.addLog('正在恢复播放...', 'primary');
                    try {
                        media.muted = true;
                        const p = media.play();
                        if (p && typeof p.catch === 'function') p.catch(() => {});
                    } catch (e) {}
                    try {
                        if (iframeWindow && iframeWindow.videojs) {
                            const player = iframeWindow.videojs('video') || iframeWindow.videojs(media);
                            if (player && typeof player.play === 'function') {
                                const p = player.play();
                                if (p && typeof p.catch === 'function') p.catch(() => {});
                            }
                        }
                    } catch (e) {}
                }, 3000);
            };

            media.addEventListener('pause', () => {
                if (media.ended || resolved) return;
                clearTimeout(resumeTimer);
                const blocked = findQuizOverlayInChain(iframeDocument);
                if (blocked) {
                    Logger.addLog(`检测到弹题（${blocked.desc}），暂停自动恢复，开始自动作答`, 'warning');
                    startQuizWait(media, iframeDocument, iframeWindow);
                    return;
                }
                Logger.addLog(`检测到 ${mediaType} 暂停，3秒后将自动恢复播放`, 'warning');
                scheduleResume();
            });

            media.addEventListener('play', () => {
                clearTimeout(resumeTimer);
                stopQuizWait(media);
            });

            media.addEventListener('ended', () => finish(media));
            media.onended = () => finish(media);

            const blockedNow = findQuizOverlayInChain(iframeDocument);
            if (blockedNow) {
                Logger.addLog(`${mediaType} 加载完成但检测到弹题，先自动作答再播放`, 'warning');
                startQuizWait(media, iframeDocument, iframeWindow);
            } else {
                try {
                    media.muted = true;
                    const p = media.play();
                    if (p && typeof p.catch === 'function') p.catch(() => {});
                } catch (e) {}
                scheduleResume(); // 若因自动播放策略未真正开始，3秒后重试
            }
        }, 1000);
    });

    /* ================= PPT/PDF 自动翻阅 ================= */
    const processPpt = async (iframeWindow) => {
        Logger.addLog("发现文档任务，正在自动翻阅...", "warning");
        try {
            const panViewIframe = iframeWindow.document.querySelector('#panView, #pdfView, #panViewFrame, .panViewFrame, iframe[src*="pan"], iframe[src*="pdf"]');
            if (!panViewIframe) {
                Logger.addLog("未找到文档查看器，跳过该文档任务", "danger");
                return Promise.resolve();
            }

            const pptWin = panViewIframe.contentWindow;
            const pptDoc = pptWin.document;
            await sleep(1.5);

            let nextBtn = pptDoc.querySelector('.nextBtn') || pptDoc.querySelector('#nextBtn');
            if (nextBtn) {
                let guard = 0;
                while (guard++ < 200) {
                    const btn = pptDoc.querySelector('.nextBtn') || pptDoc.querySelector('#nextBtn');
                    if (!btn) break;
                    const disabled = btn.style.display === 'none'
                        || /disable/i.test(classStr(btn))
                        || btn.disabled
                        || btn.getAttribute('aria-disabled') === 'true';
                    if (disabled) break;
                    btn.click();
                    await sleep(0.4);
                }
            } else {
                let currentPos = 0;
                let totalHeight = pptDoc.body ? pptDoc.body.scrollHeight : 0;
                if (!totalHeight && pptDoc.documentElement) totalHeight = pptDoc.documentElement.scrollHeight;
                const step = 800;
                let guard = 0;
                while (currentPos < totalHeight && guard++ < 300) {
                    currentPos += step;
                    try { pptWin.scrollTo({ top: currentPos, behavior: 'auto' }); } catch (e) { pptWin.scrollTo(0, currentPos); }
                    await sleep(0.4);
                    const h = pptDoc.body ? pptDoc.body.scrollHeight : (pptDoc.documentElement ? pptDoc.documentElement.scrollHeight : 0);
                    totalHeight = Math.max(totalHeight, h);
                }
                try { pptWin.scrollTo(0, totalHeight); } catch (e) {}

                // PDF 专用翻页按钮兜底
                const pageNext = pptDoc.querySelector('.nextPageBtn, #nextPage, .pageDown, .pdf-next, [class*="nextPage" i]');
                if (pageNext) {
                    let guard = 0;
                    while (guard++ < 200 && pageNext && pageNext.style.display !== 'none' && !/disable/i.test(classStr(pageNext))) {
                        pageNext.click();
                        await sleep(0.35);
                    }
                }
            }
            await sleep(1);
            Logger.addLog("文档（PPT/PDF）翻阅完成", "success");
        } catch (e) {
            Logger.addLog("文档任务处理异常，尝试继续下一任务", "danger");
        }
        return Promise.resolve();
    };

    /* ================= 任务调度 ================= */
    const getAllIframes = (doc) => {
        let iframes = Array.from(doc.querySelectorAll('iframe'));
        let all = [];
        for (let f of iframes) {
            all.push(f);
            try { if (f.contentDocument) all = all.concat(getAllIframes(f.contentDocument)); } catch (e) {}
        }
        return all;
    };

    const goToNextChapter = () => {
        const nextBtnStatus = document.querySelector("#prevNextFocusNext");
        if (!nextBtnStatus || nextBtnStatus.style.display === "none") {
            Logger.addLog("已经到达最后一章节，无法跳转", "danger");
        } else {
            const nextClickBtn = document.querySelector(".jb_btn.jb_btn_92.fr.fs14.nextChapter");
            if (nextClickBtn) {
                Logger.addLog("正前往下一章节...", "success");
                nextClickBtn.click();
            } else {
                Logger.addLog("未找到下一章按钮元素，自动跳转失败", "danger");
            }
        }
    };

    let isProcessing = false;
    let currentTaskId = 0;

    const processIframeTask = async () => {
        if (isProcessing) return;
        isProcessing = true;
        const thisTaskId = ++currentTaskId;

        try {
            const allIframes = getAllIframes(document);
            let taskPromises = [];
            const processedIframes = new Set();

            for (let iframe of allIframes) {
                try {
                    const doc = iframe.contentDocument;
                    const win = iframe.contentWindow;

                    if (!doc || !win || processedIframes.has(iframe)) continue;

                    // 排除弹题/问卷/弹窗等非任务 iframe（避免把弹题里的音频误当成任务）
                    try {
                        if (iframe.closest('.ans-videoquiz, .customMaskDiv, .customMaskDiv2, .voteContainer, .maskDiv, .maskDivReport, #aiAssistantId')) continue;
                    } catch (e) {}

                    // 只处理“任务点” iframe：位于任务容器内，或带任务属性(jobid/objectid/mid/data)
                    const jobHolder = iframe.closest('.ans-attach-ct, .ans-job-ct, .ans-job-icon, [class*="ans-job"]');
                    const jobData = iframe.getAttribute('data') || '';
                    const jobAttrs = !!(iframe.getAttribute('jobid') || iframe.getAttribute('jobId')
                        || iframe.getAttribute('mid') || iframe.getAttribute('objectid')
                        || jobData.indexOf('jobid') !== -1);
                    if (!jobHolder && !jobAttrs) continue;
                    if (jobHolder && (jobHolder.classList.contains('ans-job-finished') || jobHolder.closest('.ans-job-finished'))) continue;

                    if (doc.querySelector("video")) {
                        processedIframes.add(iframe);
                        taskPromises.push(processMedia("video", doc, win));
                    } else if (doc.querySelector("audio")) {
                        processedIframes.add(iframe);
                        taskPromises.push(processMedia("audio", doc, win));
                    } else if (win.document.querySelector("#panView, #pdfView, #panViewFrame, .panViewFrame, iframe[src*='pan'], iframe[src*='pdf']")) {
                        processedIframes.add(iframe);
                        taskPromises.push(processPpt(win));
                    }
                } catch (e) {}
            }

            if (taskPromises.length > 0) {
                Logger.addLog(`精准识别到 ${taskPromises.length} 个未完成多媒体任务，开始处理...`, "warning");
                await Promise.all(taskPromises);
            }

            if (thisTaskId !== currentTaskId) return;

            // 跳转前等待弹题完全关闭（自动作答进行中）
            if (isAnyQuizBlocked()) {
                Logger.addLog("存在未完成的答题弹窗，等待自动作答完成后跳转...", "warning");
                let lastLog = 0;
                while (thisTaskId === currentTaskId && isAnyQuizBlocked()) {
                    await sleep(1);
                    const now = Date.now();
                    if (now - lastLog > 20000) {
                        lastLog = now;
                        Logger.addLog("仍在等待答题弹窗关闭（不会绕过）...", "warning");
                    }
                }
            }

            if (thisTaskId !== currentTaskId) return;

            Logger.addLog("已知多媒体任务处理完毕，跳过章节习题，前往下一节", "success");
            await sleep(3);
            if (thisTaskId === currentTaskId && !isAnyQuizBlocked()) {
                goToNextChapter();
            } else {
                Logger.addLog("跳转已取消（页面切换或弹窗未完成）", "danger");
            }
        } finally {
            if (thisTaskId === currentTaskId) isProcessing = false;
        }
    };

    /* ================= 初始化 ================= */
    const init = () => {
        const url = window.location.href;
        if (!url.includes("studentstudy")) return;

        if (!url.includes("mooc2=1")) {
            window.location.href = url + (url.includes("?") ? "&" : "?") + "mooc2=1";
            return;
        }

        Logger.addLog("核心引擎已就绪", "success");

        let lastUrl = url;
        let lastIframeSrc = '';
        let lastResetAt = 0;

        const resetEngine = (reason) => {
            const now = Date.now();
            if (now - lastResetAt < 600) return;
            lastResetAt = now;
            lastUrl = window.location.href;
            const iframe = document.getElementById('iframe');
            lastIframeSrc = iframe ? (iframe.getAttribute('src') || '') : '';
            Logger.addLog(reason, "primary");
            isProcessing = false;
            currentTaskId++;
            setTimeout(processIframeTask, 3000);
        };

        setInterval(() => {
            const nowUrl = window.location.href;
            const iframe = document.getElementById('iframe');
            const nowSrc = iframe ? (iframe.getAttribute('src') || '') : '';
            if (nowUrl !== lastUrl) {
                lastUrl = nowUrl;
                resetEngine("检测到页面切换，重置引擎状态...");
                return;
            }
            if (nowSrc && nowSrc !== lastIframeSrc) {
                lastIframeSrc = nowSrc;
                resetEngine("检测到任务卡片切换，重置引擎状态...");
            }
        }, 1000);

        try {
            const target = document.getElementById('mainid') || document.body;
            const obs = new MutationObserver(() => resetEngine("检测到章节内容变化，重置引擎状态..."));
            obs.observe(target, { childList: true, subtree: true });
            const iframe = document.getElementById('iframe');
            if (iframe) {
                const obs2 = new MutationObserver(() => resetEngine("检测到iframe地址变化，重置引擎状态..."));
                obs2.observe(iframe, { attributes: true, attributeFilter: ['src'] });
            }
        } catch (e) {}

        // 全局弹题监管：无论当前是否在播放（含视频结束瞬间/文档任务期间），
        // 只要检测到未完成的答题弹窗就自动作答，弹窗不关闭绝不放行跳转/恢复播放。
        setInterval(() => {
            try {
                if (AnswerBot.working || Date.now() - AnswerBot.lastRun <= 2500) return;
                const blocked = isAnyQuizBlocked();
                if (blocked) AnswerBot.start(blocked);
            } catch (e) {}
        }, 800);

        setTimeout(processIframeTask, 4000);
    };

    init();

})();
