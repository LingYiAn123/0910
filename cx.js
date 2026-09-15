// ==UserScript==
// @name         🥇网课小助手|超星学习通+优学院
// @namespace    noshuang
// @version      0.8.0
// @author       Modified
// @description  ①超星：自动播放视频/音频、PPT/PDF翻阅、章节任务点自动作答（只保存不提交）。②优学院：仅自动学习课件前6专题、拟人节奏、不做题。面板开关可持久化，支持自定义 AI 模型提供方(API/模型/思考强度)。
// @match        https://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://*.ulearning.cn/*
// @match        *://ulearning.cn/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const isYxyHost = /ulearning/i.test(location.hostname || '');
    // 优学院允许在 iframe 内运行（学习页可能在框架中）；超星仍只运行顶层
    if (window.top !== window.self && !isYxyHost) return;

    // 页面真实 window：@grant unsafeWindow 时优先用它读页面全局（videojs / __CX_AUTO_ANSWER 等）
    const pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    /* ================= 持久化存储（仅偏好设置，不含任何账号/隐私数据） ================= */
    const STORE_KEY = 'nc_assistant_settings_v1';
    const safeJSON = {
        parse(s) { try { return JSON.parse(s); } catch (e) { return null; } },
        stringify(o) { try { return JSON.stringify(o); } catch (e) { return ''; } }
    };

    /* ================= 面板开关（localStorage 持久化） ================= */
    const DEFAULTS = {
        cx: true,        // 超星引擎
        yxy: true,       // 优学院引擎
        limit6: true,    // 优学院只学前 6 个专题
        answerPop: false, // 视频/课程中间弹题自动作答（默认关：作答行为最易触发风控，需要时再开）
        answerTask: false, // 任务点题目自动作答（默认关，风控更稳）
        humanize: true,  // 拟人操作（随机节奏/防挂机）
        aiEnabled: false, // 是否启用 AI 作答
        aiProvider: 'custom',
        aiBaseURL: 'https://api.siliconflow.cn/v1',
        aiApiKey: '',
        aiModel: 'deepseek-ai/DeepSeek-V3.2',
        aiEffort: 'off',   // off / low / medium / high / max
        aiTimeout: 120000, // AI 请求超时(ms)；开启AI时禁用排除法，超时越大越稳
        aiModels: [],      // 从 /models 探测到的可用模型列表
        aiModelMeta: {}    // { 模型名: { efforts:[...] } } 各模型的思考等级能力
    };
    const Settings = Object.assign({}, DEFAULTS);
    const loadSettings = () => {
        try {
            const saved = safeJSON.parse(localStorage.getItem(STORE_KEY) || '');
            if (saved && typeof saved === 'object') Object.assign(Settings, saved);
        } catch (e) {}
    };
    const saveSettings = () => {
        try { localStorage.setItem(STORE_KEY, safeJSON.stringify(Settings)); } catch (e) {}
    };
    loadSettings();

    // 自定义模型提供方（参考 DSH 的 provider 结构：baseURL / apiKey / models / reasoningEfforts）
    const AI_PROVIDERS = {
        custom: {
            displayName: '自定义提供方',
            baseURL: Settings.aiBaseURL || 'https://api.siliconflow.cn/v1',
            models: []
        },
        siliconflow: {
            displayName: 'SiliconFlow 硅基流动',
            baseURL: 'https://api.siliconflow.cn/v1',
            models: ['deepseek-ai/DeepSeek-V3.2', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-32B', 'zai-org/GLM-4.5-Air']
        },
        openai: {
            displayName: 'OpenAI 兼容',
            baseURL: 'https://api.openai.com/v1',
            models: ['gpt-4o-mini', 'gpt-4o']
        }
    };
    const AI_EFFORTS = ['off', 'low', 'medium', 'high', 'max'];
    const EFFORT_LABEL = { off: '关闭思考', low: '低', medium: '中', high: '高', max: '最高' };

    /* ================= 日志面板（懒创建：只有进入支持的页面才显示） ================= */
    let Logger = null;
    // 安全日志：Logger 可能尚未创建（懒加载）或创建失败（页面异常）——
    // 全脚本统一走 log()，杜绝 "Cannot read properties of null (reading 'addLog')" 崩溃
    const log = (msg, type) => {
        try {
            if (!Logger) {
                Logger = ensureLogger();
            } else if (Logger.__host && !Logger.__host.isConnected) {
                // 宿主被页面(SPA)摘掉 → 重新挂载（每次记日志都检查，保证自愈）
                try {
                    const mountRoot = document.body || document.documentElement;
                    if (mountRoot) mountRoot.appendChild(Logger.__host);
                } catch (e) {}
            }
            // 必须调 Logger.addLog —— 调用 log() 会无限递归导致栈溢出（面板消失/脚本全崩的根因）
            if (Logger && Logger.addLog) Logger.addLog(msg, type);
        } catch (e) {}
    };
    const PANEL_CSS = `
        .nc-panel{position:fixed;top:120px;right:20px;width:344px;background:#fff;border-radius:12px;
            box-shadow:0 10px 32px rgba(15,23,42,.18);z-index:999999;font-size:13px;
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
            overflow:hidden;border:1px solid #e8ecf3;color:#1f2937;}
        .nc-hd{background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;padding:11px 14px;
            font-weight:600;cursor:move;user-select:none;display:flex;justify-content:space-between;align-items:center;}
        .nc-hd .nc-tag{font-size:10px;background:rgba(255,255,255,.22);padding:2px 7px;border-radius:999px;font-weight:500;}
        .nc-hd .nc-min{cursor:pointer;padding:0 4px;opacity:.9;font-weight:700;}
        .nc-body{max-height:70vh;overflow-y:auto;}
        .nc-sec{border-bottom:1px solid #eef2f7;}
        .nc-sec-hd{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;
            background:#f7f9fc;cursor:pointer;user-select:none;font-weight:600;font-size:12px;color:#475569;}
        .nc-sec-hd .nc-arrow{transition:transform .18s;font-size:10px;color:#94a3b8;}
        .nc-sec.collapsed .nc-arrow{transform:rotate(-90deg);}
        .nc-sec.collapsed .nc-sec-bd{display:none;}
        .nc-sec-bd{padding:8px 12px;display:flex;flex-wrap:wrap;gap:8px 14px;}
        .nc-sw{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#334155;}
        .nc-sw input{width:14px;height:14px;accent-color:#2563eb;cursor:pointer;}
        .nc-field{display:flex;align-items:center;gap:6px;width:100%;font-size:12px;color:#475569;}
        .nc-field label{flex:0 0 64px;text-align:right;color:#64748b;}
        .nc-field input,.nc-field select{flex:1;min-width:0;height:26px;border:1px solid #dbe2ea;border-radius:6px;
            padding:0 7px;font-size:12px;background:#fff;color:#1f2937;outline:none;}
        .nc-field input:focus,.nc-field select:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.12);}
        .nc-btn{height:26px;padding:0 12px;border:none;border-radius:6px;background:#2563eb;color:#fff;
            font-size:12px;cursor:pointer;}
        .nc-btn:hover{background:#1d4ed8;}
        .nc-btn.ghost{background:#eef2f7;color:#475569;}
        .nc-tip{font-size:11px;color:#94a3b8;line-height:1.5;padding:2px 12px 8px;}
        .nc-log{padding:10px 12px;height:230px;overflow-y:auto;background:#fbfcfe;}
        .nc-log p{margin:0 0 8px;line-height:1.5;border-bottom:1px dashed #eef2f7;padding-bottom:5px;}
        .nc-log .t{color:#94a3b8;font-size:11px;margin-right:7px;}
        .nc-hint{display:inline-block;width:12px;height:12px;line-height:12px;text-align:center;border-radius:50%;
            background:#e2e8f0;color:#64748b;font-size:10px;cursor:help;margin-left:2px;}
    `;
    const ensureLogger = () => {
        if (Logger) {
            // 自愈：页面(SPA)可能把宿主节点摘掉，此时 Logger 仍在但面板不可见 →
            // 检测挂载状态并重新挂载，避免"日志消失、重启也不显示"
            try {
                if (Logger.__host && !Logger.__host.isConnected) {
                    const root = document.body || document.documentElement;
                    if (root) root.appendChild(Logger.__host);
                }
            } catch (e) {}
            return Logger;
        }

        /* 面板整体放入 closed Shadow DOM：
         *  - 页面 JS 无法通过 document.querySelector('.nc-panel') 扫到内部节点
         *  - 宿主节点用中性标签，且不含任何可识别属性
         *  - 页面移除宿主时，下一次记日志会自愈重挂 */
        const hostEl = document.createElement('div');
        try { hostEl.style.cssText = 'all:initial;'; } catch (e) {}
        let shadow = null;
        try { shadow = hostEl.attachShadow({ mode: 'closed' }); } catch (e) { shadow = null; }
        const root = shadow || hostEl;   // 极老浏览器不支持 shadow 时退化为普通挂载

        if (shadow) {
            const st = document.createElement('style');
            st.textContent = PANEL_CSS;
            root.appendChild(st);
        }

        const container = document.createElement('div');
        container.className = 'nc-panel';

        const header = document.createElement('div');
        header.className = 'nc-hd';
        header.innerHTML = `<span>网课小助手</span><span class="nc-tag">v0.8.0</span><span class="nc-min" title="折叠/展开">—</span>`;
        const minBtn = header.querySelector ? header.querySelector('.nc-min') : null;

        const body = document.createElement('div');
        body.className = 'nc-body';

        const logArea = document.createElement('div');
        logArea.className = 'nc-log';

        const mkSec = (title, collapsed) => {
            const sec = document.createElement('div');
            sec.className = 'nc-sec' + (collapsed ? ' collapsed' : '');
            const hd = document.createElement('div');
            hd.className = 'nc-sec-hd';
            hd.innerHTML = `<span>${title}</span><span class="nc-arrow">▼</span>`;
            const bd = document.createElement('div');
            bd.className = 'nc-sec-bd';
            hd.addEventListener('click', () => sec.classList.toggle('collapsed'));
            sec.appendChild(hd);
            sec.appendChild(bd);
            return { sec, bd };
        };

        const mkSwitch = (label, key, tip) => {
            const lab = document.createElement('label');
            lab.className = 'nc-sw';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!Settings[key];
            cb.addEventListener('change', () => {
                Settings[key] = cb.checked;
                saveSettings();
                if (Logger) log((cb.checked ? '已开启：' : '已关闭：') + label, 'primary');
            });
            lab.appendChild(cb);
            lab.appendChild(document.createTextNode(label));
            if (tip) {
                const h = document.createElement('span');
                h.className = 'nc-hint';
                h.title = tip;
                h.textContent = '?';
                lab.appendChild(h);
            }
            return lab;
        };

        const mkField = (labelText, node) => {
            const row = document.createElement('div');
            row.className = 'nc-field';
            const label = document.createElement('label');
            label.textContent = labelText;
            row.appendChild(label);
            row.appendChild(node);
            return row;
        };

        // —— 引擎开关 ——
        const secEngine = mkSec('平台引擎', false);
        secEngine.bd.appendChild(mkSwitch('超星', 'cx', '超星学习通自动学习'));
        secEngine.bd.appendChild(mkSwitch('优学院', 'yxy', '优学院自动学习'));
        secEngine.bd.appendChild(mkSwitch('优学院前6专题', 'limit6', '只学前6个专题，防反作弊'));
        secEngine.bd.appendChild(mkSwitch('拟人操作', 'humanize', '随机节奏、防挂机检测'));

        // —— 答题开关（可持久化，独立控制） ——
        const secAnswer = mkSec('答题开关', false);
        secAnswer.bd.appendChild(mkSwitch('课程中间弹题', 'answerPop', '视频播放中弹出的题目，自动作答'));
        secAnswer.bd.appendChild(mkSwitch('任务点题目', 'answerTask', '章节/任务点作业题目自动作答（默认关，风控更稳）'));

        // —— AI 配置接口 ——
        const secAI = mkSec('AI 答题配置', true);
        secAI.bd.appendChild(mkField('启用AI', (() => {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!Settings.aiEnabled;
            cb.style.flex = '0 0 auto';
            cb.addEventListener('change', () => { Settings.aiEnabled = cb.checked; saveSettings(); });
            const wrap = document.createElement('span');
            wrap.style.cssText = 'flex:1;display:flex;align-items:center;gap:8px;';
            wrap.appendChild(cb);
            const tip = document.createElement('span');
            tip.style.cssText = 'font-size:11px;color:#94a3b8;';
            tip.textContent = '关闭则用内置排除法';
            wrap.appendChild(tip);
            return wrap;
        })()));

        // 前向占位：提供方切换时可能需要刷新模型/思考强度（这些函数在下方定义）
        let refreshModels = () => {};
        let syncEffort = () => {};

        const providerSel = document.createElement('select');
        Object.keys(AI_PROVIDERS).forEach(k => {
            const o = document.createElement('option');
            o.value = k;
            o.textContent = AI_PROVIDERS[k].displayName;
            providerSel.appendChild(o);
        });
        providerSel.value = Settings.aiProvider;
        providerSel.addEventListener('change', () => {
            Settings.aiProvider = providerSel.value;
            const p = AI_PROVIDERS[providerSel.value];
            if (p) {
                Settings.aiBaseURL = p.baseURL;
                baseInput.value = p.baseURL;
                // 换提供方：清空上一个提供方探测到的模型，回退到内置列表
                Settings.aiModels = [];
                Settings.aiModelMeta = {};
                if (p.models && p.models.length) Settings.aiModel = p.models[0];
                refreshModels(p.models || [], Settings.aiModel);
                syncEffort();
            }
            saveSettings();
        });
        secAI.bd.appendChild(mkField('提供方', providerSel));

        const baseInput = document.createElement('input');
        baseInput.type = 'text';
        baseInput.placeholder = 'https://api.example.com/v1';
        baseInput.value = Settings.aiBaseURL;
        baseInput.addEventListener('input', () => { Settings.aiBaseURL = baseInput.value.trim(); saveSettings(); });
        secAI.bd.appendChild(mkField('BaseURL', baseInput));

        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.placeholder = 'sk-...（仅保存在本机 localStorage）';
        keyInput.value = Settings.aiApiKey || '';
        keyInput.addEventListener('input', () => { Settings.aiApiKey = keyInput.value.trim(); saveSettings(); });
        secAI.bd.appendChild(mkField('API Key', keyInput));

        // —— 模型选择：带筛选搜索框（借鉴 DSH 的模型/能力选择）——
        const modelBox = document.createElement('span');
        modelBox.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:6px;min-width:0;';

        const searchRow = document.createElement('span');
        searchRow.style.cssText = 'display:flex;gap:6px;min-width:0;';
        const modelSearch = document.createElement('input');
        modelSearch.type = 'text';
        modelSearch.placeholder = '筛选模型…';
        modelSearch.style.flex = '1';
        const probeBtn = document.createElement('button');
        probeBtn.type = 'button';
        probeBtn.className = 'nc-btn';
        probeBtn.textContent = '探测';
        probeBtn.title = '用当前 BaseURL + Key 自动探测可用模型';
        searchRow.appendChild(modelSearch);
        searchRow.appendChild(probeBtn);

        const modelSel = document.createElement('select');
        modelSel.style.width = '100%';
        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.placeholder = '或直接填写自定义模型名';
        modelInput.value = Settings.aiModel || '';

        modelBox.appendChild(searchRow);
        modelBox.appendChild(modelSel);
        modelBox.appendChild(modelInput);

        let modelList = [];
        let modelMeta = Settings.aiModelMeta || {};

        // 单一权威：任何来源改变模型，都写回 Settings 并持久化
        const setModel = (val, syncInput) => {
            const v = (val || '').trim();
            Settings.aiModel = v;
            if (syncInput && modelInput.value !== v) modelInput.value = v;
            saveSettings();
            syncEffort();
        };

        const renderModels = (models, cur) => {
            modelList = (models || []).slice();
            const kw = (modelSearch.value || '').trim().toLowerCase();
            const filtered = kw ? modelList.filter(m => m.toLowerCase().indexOf(kw) !== -1) : modelList;
            modelSel.innerHTML = '';
            if (!filtered.length) {
                const o = document.createElement('option');
                o.value = '';
                o.textContent = modelList.length ? '（无匹配，修改筛选词）' : '（点“探测”获取模型，或直接填写）';
                modelSel.appendChild(o);
                // 列表为空时不动用户已填的模型值
            } else {
                filtered.forEach(m => {
                    const o = document.createElement('option');
                    o.value = m;
                    o.textContent = m;
                    modelSel.appendChild(o);
                });
                // 当前 Settings.aiModel 在列表里就选中它，否则选第一个
                const pick = filtered.indexOf(Settings.aiModel) >= 0 ? Settings.aiModel : filtered[0];
                modelSel.value = pick;
                // 关键修复：下拉自动选中的值必须写回 Settings（此前只改 DOM，导致面板有值、引擎读空）
                if (pick !== Settings.aiModel) setModel(pick, true);
            }
        };
        refreshModels = (models, cur) => renderModels(models, cur);

        // 探测：从 /models 拉取列表与思考能力（同一配置 60 秒内不重复请求）
        let lastProbe = { key: '', at: 0 };
        const doProbe = async () => {
            const probeKey = (Settings.aiBaseURL || '') + '|' + (Settings.aiApiKey || '');
            const now = Date.now();
            if (probeKey === lastProbe.key && now - lastProbe.at < 60000 && Settings.aiModels && Settings.aiModels.length) {
                renderModels(Settings.aiModels, Settings.aiModel);
                syncEffort();
                log(`复用 ${now - lastProbe.at < 60000 ? '60 秒内' : ''}已探测的 ${Settings.aiModels.length} 个模型`, 'primary');
                return;
            }
            probeBtn.disabled = true;
            const oldText = probeBtn.textContent;
            probeBtn.textContent = '探测中…';
            if (!Logger) ensureLogger();
            try {
                log(`正在探测模型：${Settings.aiBaseURL}`, 'primary');
                const r = await probeModels();
                Settings.aiModels = r.ids;
                Settings.aiModelMeta = r.meta;
                modelMeta = r.meta;
                saveSettings();
                lastProbe = { key: probeKey, at: Date.now() };
                renderModels(r.ids, Settings.aiModel);
                syncEffort();
                log(`探测成功：发现 ${r.ids.length} 个模型`, 'success');
            } catch (e) {
                log('模型探测失败：' + ((e && e.message) || e), 'danger');
            } finally {
                probeBtn.disabled = false;
                probeBtn.textContent = oldText;
            }
        };
        probeBtn.addEventListener('click', doProbe);
        modelSearch.addEventListener('input', () => renderModels(modelList, Settings.aiModel));

        modelSel.addEventListener('change', () => {
            if (modelSel.value) setModel(modelSel.value, true);
        });
        modelInput.addEventListener('input', () => setModel(modelInput.value, false));

        // 初始化模型列表：优先已探测结果，否则用内置提供方模型
        renderModels(
            (Settings.aiModels && Settings.aiModels.length) ? Settings.aiModels
                : (AI_PROVIDERS[Settings.aiProvider] && AI_PROVIDERS[Settings.aiProvider].models) || [],
            Settings.aiModel
        );
        secAI.bd.appendChild(mkField('模型', modelBox));

        // —— 思考强度：按所选模型能力动态生成（借鉴 DSH 的 reasoningEfforts）——
        const effortSel = document.createElement('select');
        effortSel.style.width = '100%';
        const effortHint = document.createElement('span');
        effortHint.style.cssText = 'flex:1;font-size:11px;color:#94a3b8;';
        // 未探测时的兜底：从 BaseURL 推断服务商（用户可能没点“探测”就直接填了模型）
        const inferProvider = () => /deepseek\.com/i.test(Settings.aiBaseURL || '') ? 'deepseek' : 'openai';
        const effortOptionsFor = (model) => {
            const meta = (Settings.aiModelMeta || {})[model];
            if (meta && meta.efforts && meta.efforts.length) return meta.efforts;
            // 未探测：DeepSeek 官方三档，其余完整五档
            return inferProvider() === 'deepseek' ? ['off', 'low', 'high', 'max'] : AI_EFFORTS.slice();
        };
        const isAdjustableModel = (model) => {
            const meta = (Settings.aiModelMeta || {})[model];
            if (meta && typeof meta.adjustable === 'boolean') return meta.adjustable;
            return true; // 未探测过的模型先给完整档位，用户可自行选择
        };
        syncEffort = () => {
            const adjustable = isAdjustableModel(Settings.aiModel);
            effortSel.innerHTML = '';
            if (!adjustable) {
                // 不支持思考的模型：思考强度不可调整，也不发送任何思考参数
                const o = document.createElement('option');
                o.value = '';
                o.textContent = '不可调整（该模型不支持思考）';
                effortSel.appendChild(o);
                effortSel.value = '';
                effortSel.disabled = true;
                Settings.aiEffort = ''; // 清空档位，避免把旧档位发给不支持思考的模型
                effortHint.textContent = '该模型无思考能力，请求时不携带任何思考参数';
                return;
            }
            effortSel.disabled = false;
            const opts = effortOptionsFor(Settings.aiModel);
            opts.forEach(e => {
                const o = document.createElement('option');
                o.value = e;
                o.textContent = EFFORT_LABEL[e] || e;
                effortSel.appendChild(o);
            });
            if (opts.indexOf(Settings.aiEffort) === -1) Settings.aiEffort = opts[0];
            effortSel.value = Settings.aiEffort;
            const metaNow = (Settings.aiModelMeta || {})[Settings.aiModel];
            const isDS = !!(metaNow && metaNow.provider === 'deepseek');
            effortHint.textContent = isDS
                ? `DeepSeek 官方档位：${opts.map(e => EFFORT_LABEL[e] || e).join(' / ')}（官方仅 low/high/max 三档，默认 high；“关闭思考”= thinking.type=disabled）`
                : `该模型支持思考等级：${opts.map(e => EFFORT_LABEL[e] || e).join(' / ')}（选“关闭思考”才是真正关闭）`;
        };
        effortSel.addEventListener('change', () => { Settings.aiEffort = effortSel.value; saveSettings(); });
        const effortWrap = document.createElement('span');
        effortWrap.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:5px;min-width:0;';
        effortWrap.appendChild(effortSel);
        effortWrap.appendChild(effortHint);
        syncEffort();
        secAI.bd.appendChild(mkField('思考强度', effortWrap));

        const timeoutInput = document.createElement('input');
        timeoutInput.type = 'number';
        timeoutInput.min = '15';
        timeoutInput.max = '600';
        timeoutInput.step = '5';
        timeoutInput.value = Math.round((parseInt(Settings.aiTimeout, 10) || 120000) / 1000);
        timeoutInput.addEventListener('change', () => {
            const sec = Math.max(15, Math.min(600, parseInt(timeoutInput.value, 10) || 120));
            Settings.aiTimeout = sec * 1000;
            timeoutInput.value = sec;
            saveSettings();
        });
        secAI.bd.appendChild(mkField('AI超时(秒)', timeoutInput));

        const tipEl = document.createElement('div');
        tipEl.className = 'nc-tip';
        tipEl.textContent = '开启 AI 后禁用排除法：脚本只等 AI 作答，绝不拿猜测答案去试。不支持思考的模型，思考强度显示“不可调整”且不会发送任何思考参数。思考模型建议超时设为 120~300 秒。API Key 只存本机 localStorage。';
        secAI.bd.appendChild(tipEl);

        body.appendChild(secEngine.sec);
        body.appendChild(secAnswer.sec);
        body.appendChild(secAI.sec);
        body.appendChild(logArea);

        container.appendChild(header);
        container.appendChild(body);
        root.appendChild(container);

        // @run-at document-start 时 body 可能还不存在 → 等 DOM 就绪再挂载（否则面板永远建不出来）
        const mountPanel = () => {
            try {
                const mountRoot = document.body || document.documentElement;
                if (!mountRoot) { setTimeout(mountPanel, 50); return; }
                if (!hostEl.parentElement) mountRoot.appendChild(hostEl);
            } catch (e) { setTimeout(mountPanel, 100); }
        };
        mountPanel();

        let isDragging = false, offsetX, offsetY;
        header.onmousedown = (e) => {
            if (e.target.classList.contains('nc-min')) return;
            isDragging = true; offsetX = e.clientX - container.offsetLeft; offsetY = e.clientY - container.offsetTop;
        };
        // 拖拽监听挂在 Shadow 根上（不污染页面 document，减少可探测痕迹）
        root.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            container.style.left = (e.clientX - offsetX) + 'px';
            container.style.top = (e.clientY - offsetY) + 'px';
            container.style.right = 'auto';
        });
        root.addEventListener('mouseup', () => { isDragging = false; });
        if (minBtn) {
            minBtn.addEventListener('click', () => {
                body.style.display = body.style.display === 'none' ? '' : 'none';
            });
        }

        const colors = { primary: '#2563eb', success: '#16a34a', warning: '#d97706', danger: '#dc2626' };

        Logger = {
            __host: hostEl,        // Shadow DOM 宿主（供自愈检测）
            __shadow: shadow,      // closed shadow 根（仅脚本内可访问）
            __logArea: logArea,
            addLog: (msg, type = 'primary') => {
                try {
                    const time = new Date().toLocaleTimeString();
                    const p = document.createElement('p');
                    p.innerHTML = `<span class="t">[${time}]</span><span style="color:${colors[type] || colors.primary};font-weight:500;">${String(msg).replace(/</g, '&lt;')}</span>`;
                    logArea.appendChild(p);
                    logArea.scrollTop = logArea.scrollHeight;
                    while (logArea.children.length > 300) logArea.removeChild(logArea.firstChild);
                } catch (e) {}
            }
        };
        try {
            const norm = (typeof normalizeBaseURL === 'function') ? normalizeBaseURL : (x) => (x || '');
            const base = norm(Settings.aiBaseURL);
            log(`面板配置已加载：AI=${Settings.aiEnabled ? '开' : '关'}｜模型=${Settings.aiModel || '(空)'}｜接口=${base || '(空)'}`, 'primary');
            if (Settings.aiEnabled && (!base || !Settings.aiModel)) {
                log('注意：AI 已开启但配置不完整，答题时会报“未配置完整”，请填写 BaseURL 并选择模型', 'warning');
            }
        } catch (e) {}
        return Logger;
    };

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

    /* ================= 真人输入模拟层（三平台通用） =================
     * 与旧式 el.click() 的区别（这是被检测的关键差异）：
     *  1) 真人 click 事件坐标 = 光标坐标；el.click() 的坐标恒为 (0,0) —— 经典机器人特征；
     *  2) 真人点击前鼠标有连续移动轨迹（pointermove/mousemove 多步），且 target 是光标下元素；
     *  3) 真人按下/抬起之间有 60~160ms 间隔，且有完整 pointerdown/pointerup 序列；
     *  4) 真人操作之间有阅读/犹豫停顿，而不是固定节奏。
     */
    const Human = {
        // 当前“虚拟光标”位置（页面级状态，跨调用连续）
        x: 0, y: 0, inited: false,

        view(el) {
            try { return el.ownerDocument && el.ownerDocument.defaultView || window; } catch (e) { return window; }
        },

        // 贝塞尔曲线路径生成（带随机控制点，模拟手腕弧线）
        bezier(x1, y1, x2, y2) {
            const cx1 = x1 + (x2 - x1) * randInt(20, 45) / 100 + randInt(-60, 60);
            const cy1 = y1 + (y2 - y1) * randInt(20, 45) / 100 + randInt(-60, 60);
            const cx2 = x1 + (x2 - x1) * randInt(55, 85) / 100 + randInt(-40, 40);
            const cy2 = y1 + (y2 - y1) * randInt(55, 85) / 100 + randInt(-40, 40);
            const steps = Math.max(6, Math.min(16, Math.round(Math.hypot(x2 - x1, y2 - y1) / 60)));
            const pts = [];
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const u = 1 - t;
                pts.push({
                    x: u * u * u * x1 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x2,
                    y: u * u * u * y1 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y2
                });
            }
            return pts;
        },

        // 光标连续移动到 (x,y)：多步 mousemove/pointermove，target 取各步命中元素
        // doc：元素所在文档（iframe 内元素的坐标是 iframe 视口坐标，必须用它自己的 elementFromPoint）
        async move(x, y, doc) {
            const from = this.inited ? { x: this.x, y: this.y }
                : { x: randInt(40, Math.max(80, (window.innerWidth || 1280) - 40)), y: randInt(40, Math.max(80, (window.innerHeight || 800) - 40)) };
            this.inited = true;
            const hitDoc = doc || document;
            const pts = this.bezier(from.x, from.y, x, y);
            for (const p of pts) {
                const tgt = (() => { try { return hitDoc.elementFromPoint(p.x, p.y) || hitDoc; } catch (e) { return hitDoc; } })();
                try {
                    tgt.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, clientX: p.x, clientY: p.y }));
                    if (typeof PointerEvent === 'function') {
                        tgt.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, view: window, clientX: p.x, clientY: p.y, pointerType: 'mouse', isPrimary: true }));
                    }
                } catch (e) {}
                await sleep(randInt(8, 25) / 1000); // 步间 8~25ms，模拟连续移动
            }
            this.x = x; this.y = y;
        },

        // 移动到元素中心附近（带随机偏移，不总是正中心）
        async moveTo(el) {
            const r = el.getBoundingClientRect();
            const w = Math.max(1, r.width), h = Math.max(1, r.height);
            const x = r.left + w * randInt(30, 70) / 100;
            const y = r.top + h * randInt(30, 70) / 100;
            await this.move(x, y, el.ownerDocument);
            return { x, y };
        },

        // 真人单击：move → over → down(60~160ms) → up → click（坐标一致，不用 el.click()）
        async click(el) {
            if (!el) return;
            try { await el.scrollIntoViewIfNeeded ? el.scrollIntoViewIfNeeded() : null; } catch (e) {}
            const pos = await this.moveTo(el);
            const doc = el.ownerDocument || document;
            const win = this.view(el);
            const fire = (type, Ctor) => {
                try {
                    const init = {
                        bubbles: true, cancelable: true, view: win,
                        clientX: pos.x, clientY: pos.y, button: 0
                    };
                    if (Ctor === PointerEvent && typeof PointerEvent === 'function') {
                        init.pointerId = 1; init.pointerType = 'mouse'; init.isPrimary = true;
                        el.dispatchEvent(new PointerEvent(type, init));
                    } else {
                        el.dispatchEvent(new MouseEvent(type, init));
                    }
                } catch (e) {}
            };
            // over/down/up 全部带一致坐标
            fire('mouseover'); fire('mouseenter', MouseEvent);
            fire('pointerover', PointerEvent); fire('pointerdown', PointerEvent);
            fire('mousedown', MouseEvent);
            await sleep(randInt(60, 160) / 1000); // 按住时长
            fire('pointerup', PointerEvent);
            fire('mouseup', MouseEvent);
            // click 用合成事件（带坐标）而不是 el.click()（坐标恒 0,0）
            try {
                el.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, cancelable: true, view: win,
                    clientX: pos.x, clientY: pos.y, button: 0
                }));
            } catch (e) { try { el.click(); } catch (_) {} }
        },

        // 阅读停顿（读题/读页面）
        async read(min, max) { await sleep(randInt(min || 2, max || 5)); },
        // 微停顿（动作间犹豫）
        async pause() { await sleep(randInt(20, 60) / 100); }
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
                    await Human.click(clickableOf(inp));
                    await sleep(randInt(20, 45) / 100);
                }
            }

            // 2) 逐个点击目标选项，真人节奏：读选项(0.8~2s)→点击→停顿
            for (const p of picks) {
                const root = clickableOf(p.el);
                await sleep(randInt(80, 200) / 100);
                await Human.click(root);
                await sleep(randInt(30, 60) / 100);
                const inp = root.querySelector ? root.querySelector('input[type="checkbox"], input[type="radio"]') : null;
                if (inp && !inp.checked) {
                    await Human.click(inp); // 容器点击未被识别时，直接点 input
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
                    await Human.click(clickableOf(inp)); // 先按交互路径再点一次
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

    /* ================= AI 答题（OpenAI 兼容 /chat/completions，参考 DSH provider 配置） ================= */
    // AI 结果按题目缓存，避免每轮重试都重复请求同一题（也更像人：同一道题不会反复问）
    const aiCache = new Map();
    let aiInflight = null;         // 正在进行的 AI 请求（同一题并发去重）
    let aiInflightKey = '';
    // 熔断：Key/账户级错误（401/402/403/429）后暂停 AI 调用，避免每道题都白试一次
    let aiBlocked = { until: 0, reason: '', code: 0 };
    const AI_FATAL_CODES = [401, 402, 403, 429];

    /**
     * 构造思考参数（按各家官方规格，不是“一套参数打天下”）：
     * - DeepSeek 官方：`thinking:{type:enabled|disabled}` 开关 + `reasoning_effort:"low|high|max"`（仅三档）
     * - 硅基流动/其他 OpenAI 兼容：`enable_thinking:bool` + `reasoning_effort:"low|medium|high"`
     * - 不支持思考的模型：完全不传，避免严格服务端 400
     */
    const buildEffortParams = (effort, model) => {
        const meta = (Settings.aiModelMeta || {})[model];
        // provider 兜底：未探测时从 BaseURL 判断（DeepSeek 官方参数格式与兼容端不同）
        const provider = (meta && meta.provider)
            || (/deepseek\.com/i.test(Settings.aiBaseURL || '') ? 'deepseek' : 'openai');
        // 优先看探测得到的能力标记；没有标记时按“支持”处理（用户可自选）
        const adjustable = (meta && typeof meta.adjustable === 'boolean')
            ? meta.adjustable
            : true;
        // 不支持思考 / 未选择档位 → 完全不传思考相关参数，避免 400
        if (!adjustable || !effort) return {};

        if (effort === 'off') {
            // DeepSeek 官方用 thinking.type=disabled 关闭；其余兼容端用 enable_thinking:false
            return provider === 'deepseek'
                ? { thinking: { type: 'disabled' } }
                : { reasoning_effort: 'none', enable_thinking: false };
        }
        if (provider === 'deepseek') {
            // 官方仅 low / high / max 三档；medium 按官方映射表归到 high
            const map = { low: 'low', medium: 'high', high: 'high', max: 'max' };
            return { thinking: { type: 'enabled' }, reasoning_effort: map[effort] || 'high' };
        }
        const map = { low: 'low', medium: 'medium', high: 'high', max: 'high' };
        return { reasoning_effort: map[effort] || 'medium', enable_thinking: true };
    };

    /**
     * 归一化 BaseURL：用户常填 https://api.deepseek.com 这类裸域名，
     * 但 OpenAI 兼容接口在 /v1 下。规则：
     *  - 已以 /chat/completions 结尾 → 去掉该后缀
     *  - 已含 /v1 或其它版本段 → 原样
     *  - 裸域名/仅路径 → 末尾补 /v1
     */
    const normalizeBaseURL = (raw) => {
        let u = (raw || '').trim().replace(/\/+$/, '');
        if (!u) return '';
        u = u.replace(/\/chat\/completions$/, '');
        if (/\/v\d+(\.\d+)?$/.test(u)) return u;      // 已带版本段
        // 常见的官方端点：裸域名需要补 /v1
        try {
            const m = u.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
            if (m) {
                const host = m[1], p = m[2] || '';
                if (!p || p === '/') return host + '/v1';
            }
        } catch (e) {}
        return u;
    };

    const aiAnswer = async (qText, options) => {
        if (!Settings.aiEnabled) return null;
        // 熔断中：直接返回 null（不再发请求）
        if (aiBlocked.until > Date.now()) return null;
        const base = normalizeBaseURL(Settings.aiBaseURL);
        const key = (Settings.aiApiKey || '').trim();
        const model = (Settings.aiModel || '').trim();
        if (!base || !model) {
            // 诊断：把当前实际读到的值打出来，便于定位是“面板有值但 Settings 空”的同步问题
            log(`AI 未配置完整：BaseURL=${base ? '已填' : '空'}｜模型=${model || '空'}。请在面板填写并点“探测”选择模型后重试`, 'danger');
            return null;
        }
        if (!window.fetch) { log('当前浏览器不支持 fetch，AI 不可用', 'danger'); return null; }

        const cacheKey = model + '|' + qText + '|' + options.map(o => o.text).join('|');
        if (aiCache.has(cacheKey)) return aiCache.get(cacheKey);          // 命中缓存，直接复用
        if (aiInflight && aiInflightKey === cacheKey) return aiInflight;  // 同一题并发去重

        const optLines = options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.text}`).join('\n');
        const prompt = `你在帮学生作答网课选择题（可能单选/多选/判断）。\n题目：${qText}\n选项：\n${optLines}\n\n只输出最终答案，不要解释。单选/判断输出一个字母；多选输出多个字母，用英文逗号分隔（如 A,C,D）。`;
        const effortParams = buildEffortParams(Settings.aiEffort, model);
        const isThinkingOn = !!(effortParams && (effortParams.thinking && effortParams.thinking.type === 'enabled'
            || effortParams.enable_thinking === true));
        const basePayload = {
            model: model,
            messages: [
                { role: 'system', content: '你是精确的答题引擎，只输出答案，不输出任何解释。' },
                { role: 'user', content: prompt }
            ],
            stream: false
        };
        // DeepSeek 官方：思考模式下 temperature 无效（官方明说不支持），此时不传更干净
        if (!(isThinkingOn && /deepseek\.com/i.test(base))) basePayload.temperature = 0.2;
        // 仅在模型支持且用户选了档位时才附加思考参数（不可调整的模型绝不携带未知字段）
        const payload = Object.keys(effortParams).length ? Object.assign(basePayload, effortParams) : basePayload;

        const timeoutMs = Math.max(8000, parseInt(Settings.aiTimeout, 10) || 60000);
        const run = (async () => {
            let timer = null;
            try {
                const controller = new AbortController();
                timer = setTimeout(() => controller.abort(), timeoutMs);
                const resp = await fetch(base + '/chat/completions', {
                    method: 'POST',
                    headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { 'Authorization': 'Bearer ' + key } : {}),
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
                if (!resp.ok) {
                    const code = resp.status;
                    // Key/账户级错误 → 全局熔断，避免后续每道题都白试一次
                    if (AI_FATAL_CODES.indexOf(code) !== -1) {
                        const mins = code === 429 ? 5 : 10;
                        aiBlocked.until = Date.now() + mins * 60 * 1000;
                        aiBlocked.code = code;
                        const reason = code === 402 ? '账户余额不足/欠费（402）'
                            : code === 401 ? 'API Key 无效（401）'
                            : code === 403 ? '无权限/Key 被禁用（403）'
                            : '请求过于频繁（429）';
                        aiBlocked.reason = reason;
                        let detail = '';
                        try { const j = await resp.json(); detail = (j && (j.message || j.error && j.error.message)) || ''; } catch (e) {}
                        log(`AI 不可用：${reason}${detail ? '｜' + detail : ''}。已暂停 AI 调用 ${mins} 分钟，后续改用排除法`, 'danger');
                    } else {
                        log(`AI 请求失败 HTTP ${code}（本轮跳过，转排除法）`, 'danger');
                    }
                    return null;
                }
                const data = await resp.json();
                const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
                const letters = String(content).trim().toUpperCase().match(/[A-H]/g);
                if (letters && letters.length) {
                    const texts = letters.map(l => options[l.charCodeAt(0) - 65] ? options[l.charCodeAt(0) - 65].text : l).filter(Boolean);
                    log(`AI 作答：${texts.join('、')}`, 'success');
                    aiCache.set(cacheKey, texts);
                    return texts;
                }
                log('AI 未返回可用选项（转排除法）', 'warning');
                return null;
            } catch (e) {
                const msg = (e && e.message) || e;
                if (/abort/i.test(String(msg))) {
                    log(`AI 超时（${Math.round(timeoutMs / 1000)}s 未返回），已降级为排除法继续作答`, 'warning');
                } else {
                    log('AI 请求异常：' + msg + '（转排除法）', 'danger');
                }
                return null;
            } finally {
                if (timer) clearTimeout(timer);
                aiInflight = null;
                aiInflightKey = '';
            }
        })();

        aiInflight = run;
        aiInflightKey = cacheKey;
        return run;
    };

    // 纯本地答案：window.__CX_AUTO_ANSWER.answers / provider（不发起任何 AI 请求）
    const localConfiguredAnswer = (qText, options) => {
        const cfg = pageWin.__CX_AUTO_ANSWER || {};
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
        return null;
    };

    // 固定题库/provider（纯本地，不调用 AI，也不走排除法之外的猜测）
    /**
     * 从 BaseURL + Key 探测可用模型（GET /models），并推断每个模型的思考等级能力。
     * 参考 DSH provider 的 models / modelOverrides.reasoningEfforts 设计。
     */
    const probeModels = async () => {
        const base = normalizeBaseURL(Settings.aiBaseURL);
        const key = (Settings.aiApiKey || '').trim();
        if (!base) throw new Error('请先填写 BaseURL');
        if (!window.fetch) throw new Error('浏览器不支持 fetch');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        let resp;
        try {
            resp = await fetch(base + '/models', {
                method: 'GET',
                headers: Object.assign({ 'Accept': 'application/json' }, key ? { 'Authorization': 'Bearer ' + key } : {}),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }
        if (!resp.ok) throw new Error(`探测失败 HTTP ${resp.status}（请检查 BaseURL/Key）`);
        const data = await resp.json();
        const list = (data && (data.data || data.models)) || [];
        const ids = list.map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);

        // 识别服务商：决定用哪套思考参数（DeepSeek 官方与 OpenAI 兼容端格式不同）
        const provider = /deepseek\.com/i.test(base) ? 'deepseek' : 'openai';

        // 推断思考能力：
        //  - DeepSeek 官方：deepseek-flash / deepseek-v4-pro 等均「默认开启思考，可切非思考」
        //    → 档位为官方三档 low/high/max（面板另有“关闭思考”映射为 thinking.type=disabled）
        //  - 其他兼容端：名字含 reason/thinking/r1/qwq/o1/o3/o4/qwen3(非coder)/glm-4.5+ 等 → 可调
        //  - 服务端若返回能力字段则优先
        const meta = {};
        ids.forEach(item => {
            const id = typeof item === 'string' ? item : (item.id || item.name);
            const raw = typeof item === 'string' ? {} : item;
            let adjustable = null;
            if (raw && (raw.reasoning === true || raw.supports_reasoning === true || raw.capabilities && raw.capabilities.reasoning)) {
                adjustable = true;
            } else if (raw && (raw.reasoning === false || raw.supports_reasoning === false)) {
                adjustable = false;
            }
            if (adjustable === null) {
                if (provider === 'deepseek') {
                    // 官方模型名（deepseek-flash / deepseek-v4-pro / 旧名 chat|reasoner）全部支持思考；
                    // 仅明确标注非思考的才排除
                    adjustable = !/embedding|rerank/i.test(id);
                } else {
                    adjustable = /reason|reasoner|thinking|r1|qwq|o1|o3|o4|qwen3(?!-coder)|glm-4\.[5-9]|deepseek-(v3\.[12]|r1|flash|v4)/i.test(id);
                }
            }
            meta[id] = {
                adjustable: adjustable,
                provider: provider,
                // DeepSeek 官方只有三档；兼容端用四档
                efforts: adjustable
                    ? (provider === 'deepseek' ? ['off', 'low', 'high', 'max'] : ['off', 'low', 'medium', 'high', 'max'])
                    : []
            };
        });
        return { ids: ids.sort(), meta, provider };
    };

    const getConfiguredAnswer = async (qText, options) => {
        const local = localConfiguredAnswer(qText, options);
        if (local) return { answer: local, fromConfig: true };
        const cfg = pageWin.__CX_AUTO_ANSWER || {};
        if (typeof cfg.provider === 'function') {
            try {
                const ans = await cfg.provider(qText, options.map(o => o.text));
                if (ans) return { answer: Array.isArray(ans) ? ans.map(String) : [String(ans)], fromConfig: true };
            } catch (e) {
                log('自定义答题 provider 出错: ' + (e && e.message || e), 'danger');
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

        // 本地固定题库/provider 答案（瞬时）优先使用，不涉及 AI、不涉及猜测
        if (!state.cfgQueried) {
            state.cfgQueried = true;
            const local = localConfiguredAnswer(qText, options.concat(judge));
            state.cfgAnswer = local || null;
            state.cfgNeedProvider = !local && typeof (pageWin.__CX_AUTO_ANSWER && pageWin.__CX_AUTO_ANSWER.provider) === 'function';
        }
        if (!state.cfgAnswer && state.cfgNeedProvider && !state.cfgProviderLoading) {
            state.cfgProviderLoading = true;
            getConfiguredAnswer(qText, options.concat(judge)).then(res => {
                state.cfgAnswer = res ? res.answer : null;
                state.cfgProviderLoading = false;
            }).catch(() => { state.cfgProviderLoading = false; });
            log('正在通过自定义 provider 取答案...', 'primary');
            return { picks: [], fills: [] };
        }
        if (state.cfgAnswer && !state.cfgTried) {
            state.cfgTried = true;
            const picks = (options.length ? options : judge).filter(o => state.cfgAnswer.some(a => matchAnswer(o, a)));
            if (picks.length) return { picks, fills: [] };
            if (fills.length && state.cfgAnswer.length) {
                fills.slice(0, state.cfgAnswer.length).forEach((el, i) => setNativeValue(el, state.cfgAnswer[i]));
                return { picks: [], fills };
            }
        }

        // AI 答案：开启 AI 时禁用排除法——**只等 AI**，等多久都行，绝不拿猜测答案去试。
        // 只有 AI 明确不可用（未配置/HTTP 错误/超时/无有效选项）才返回 null，此时才允许走排除法。
        if (Settings.aiEnabled) {
            if (!state.aiStarted) {
                state.aiStarted = true;
                state.aiPromise = aiAnswer(qText, options.concat(judge))
                    .then(ans => { state.aiAnswer = ans || null; state.aiSettled = true; return ans; })
                    .catch(() => { state.aiAnswer = null; state.aiSettled = true; return null; });
            }
            if (!state.aiTried) {
                // ==============================================================================
                // 一直等 AI 返回（不设降级等待）；期间日志节流提示，避免刷屏
                if (!state.aiAnswer && state.aiPromise && !state.aiSettled) {
                    const waitLog = setInterval(() => {
                        if (state.aiAnswer || state.aiSettled) { clearInterval(waitLog); return; }
                        log('AI 思考中，保持等待（已禁用排除法，不会用猜测答案顶替）', 'primary');
                    }, 15000);
                    try {
                        await state.aiPromise;
                    } finally {
                        clearInterval(waitLog);
                    }
                }
                if (!state.aiAnswer) {
                    // 仅在本题首次判定 AI 不可用时提示一次，避免每轮刷屏
                    if (!state.aiFallback) {
                        const wait = aiBlocked.until > Date.now()
                            ? `（AI 熔断中：${aiBlocked.reason || 'Key/账户不可用'}，约 ${Math.ceil((aiBlocked.until - Date.now()) / 60000)} 分钟后重试）`
                            : '';
                        log(`AI 未返回可用答案，本题改用排除法兜底${wait}`, 'warning');
                    }
                    state.aiFallback = true;
                } else {
                    state.aiTried = true;
                    const picks = (options.length ? options : judge).filter(o => state.aiAnswer.some(a => matchAnswer(o, a)));
                    if (picks.length) return { picks, fills: [] };
                    // AI 给的答案在选项中匹配不到 → 视为不可用
                    if (!state.aiFallback) log('AI 返回的答案无法匹配当前选项，改用排除法兜底', 'warning');
                    state.aiAnswer = null;
                    state.aiFallback = true;
                }
            } else {
                // 本题 AI 已作答过：AI 也答错时**不再猜答案**（禁用排除法），停下等人工处理
                return { picks: [], fills: [], reason: 'AI 作答未通过，已禁用排除法（避免反复试错触发风控，请人工处理）' };
            }
        }

        // 双保险：AI 开启且 AI 未明确不可用（未设置 fallback）时，禁止进入排除法猜测
        if (Settings.aiEnabled && !state.aiFallback) {
            if (state.aiTried) {
                return { picks: [], fills: [], reason: 'AI 作答未通过，已禁用排除法（请人工处理该弹题）' };
            }
            return { picks: [], fills: [], reason: 'AI 思考中，已禁用排除法（不使用猜测答案）' };
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
                    log(
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
        // ======================================================================================
        // 全量组合已试完：不再刷屏重试，仅节流提示（不强制恢复播放）
        if (state.fullCycleDone) {
            const nowL = Date.now();
            if (!state.cycleLogAt || nowL - state.cycleLogAt >= 30000) {
                state.cycleLogAt = nowL;
                log('该多选题全部组合已尝试仍未答对。请配置 window.__CX_AUTO_ANSWER.answers 后刷新，或手动完成（弹窗不会自动关闭、不会强制恢复播放）', 'danger');
            }
            return false;
        }

        const qEl = findQuestionEl(doc, rootEl);
        const qText = getQuestionText(qEl);
        log(`自动作答弹题：${qText.slice(0, 50) || '(未识别题干)'}`, 'warning');

        let contentReady = false;
        for (let i = 0; i < 75; i++) {
            if (collectOptions(doc, rootEl).length || findJudgeButtons(doc, rootEl).length || findFillInputs(doc, rootEl).length
                || doc.querySelector('.ans-videoquiz-opt label, .ans-videoquiz label')) {
                contentReady = true;
                break;
            }
            if (i % 10 === 9) log('等待弹题内容加载...', 'primary');
            await sleep(0.2);
        }
        if (!contentReady) {
            log('弹题内容未加载或跨域不可访问', 'danger');
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
                // 失败提示节流（30s 一条），避免刷屏
                const nowLog = Date.now();
                if (state.cycleLogAt && nowLog - state.cycleLogAt < 30000) return false;
                state.cycleLogAt = nowLog;
                log(`自动作答暂停：${res.reason || '无可用选项'}`, 'danger');
                return false;
            }
            if (res.picks.length) {
                log(`弹题第 ${attempt} 次选择：${res.picks.map(p => p.text).join('、')}`, 'primary');
                await selectPicks(doc, res.picks, isMulti); // 模拟人工勾选：清空→逐个点→校验
                await sleep(randInt(30, 60) / 100);
            }
            const submit = findSubmitBtn(doc, rootEl);
            if (submit) await Human.click(submit);
            await sleep(randInt(18, 25) / 10); // 1.8~2.5s 人工反馈等待

            if (!findQuizOverlayInChain(blocked.doc)) {
                log('弹题作答完成，弹窗已关闭', 'success');
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
                    if (btn) { await Human.click(btn); await sleep(0.8); }
                    try { if (vq.parentNode) vq.parentNode.removeChild(vq); } catch (e) {}
                    log('弹题作答完成（答对），弹窗已关闭', 'success');
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
                    await Human.click(close);
                    await sleep(1.2);
                    if (!findQuizOverlayInChain(blocked.doc)) {
                        log('弹题作答完成，弹窗已关闭', 'success');
                        return true;
                    }
                }
            }
        }
        log('自动作答达到尝试上限，弹窗仍未关闭（不会强制恢复播放）', 'danger');
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
            if (!Settings.cx) return;
            if (!Settings.answerPop) return; // 面板“课程中间弹题”开关
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
                    log('弹题窗口跨域不可访问，无法自动作答（不会强制恢复播放）', 'danger');
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
                        cycleLogAt: 0,
                        cfgQueried: false,  // 本地配置答案是否查过
                        cfgAnswer: null,    // 本地配置答案
                        cfgTried: false,    // 本地配置答案是否已提交过
                        aiStarted: false,   // AI 请求是否已发起（不阻塞）
                        aiPromise: null,    // AI 请求 Promise
                        aiAnswer: null,     // AI 返回结果（后台写回）
                        aiTried: false      // AI 答案是否已用过一次
                    };
                    this.stateMap.set(key, state);
                } else {
                    state.tried = this.triedMap.get(key);
                    state.wrong = this.wrongMap.get(key);
                    // 换题（题干变化）→ 重置本题的答案状态，重新判断
                    if (qText && state.lastQText && state.lastQText !== qText) {
                        state.cfgQueried = false; state.cfgAnswer = null; state.cfgTried = false;
                        state.aiStarted = false; state.aiPromise = null; state.aiAnswer = null; state.aiTried = false;
                    }
                }
                if (qText) state.lastQText = qText;

                const ok = await answerPopupOnce(blocked, ctx, state);
                if (ok) {
                    this.currentKey = '';
                    this.stateMap.delete(key);
                    this.triedMap.delete(key);
                    this.wrongMap.delete(key);
                    this.qTextMap.delete(key);
                }
            } catch (e) {
                log('自动作答异常：' + (e && e.message || e), 'danger');
            } finally {
                this.working = false;
                this.lastRun = Date.now();
            }
        }
    };

    /* ================= 播放恢复（弹题期间绝不 resume） ================= */
    const quizWaitCleanupMap = new WeakMap();

    /**
     * 真人式播放：优先点击页面上可见的播放按钮（vjs 大按钮 / 控制条），
     * 找不到可见按钮时才降级到播放器 API（autoplay 兜底，保证进度不卡死）。
     * 弹题 iframe 内的元素用 Human.click（坐标与光标一致）。
     */
    const playMediaLikeHuman = async (media, mediaWin, mediaDoc) => {
        // 静音优先走"点音量键"真人路径：直接写 muted 属性会触发没有对应 UI 动作的
        // volumechange 事件（部分平台播放器内部有监听），优先走真实 UI 操作
        try {
            const docM = mediaDoc || media.ownerDocument || document;
            const volIcon = docM.querySelector('.volumeBox .volumeIcon, .vjs-mute-control');
            if (volIcon && isVisible(volIcon) && !media.muted) {
                await Human.click(volIcon);
            } else {
                media.muted = true;
            }
        } catch (e) { try { media.muted = true; } catch (_) {} }
        // 1) 找可见的播放按钮（videojs 大按钮/控制条播放键）
        try {
            const doc = mediaDoc || media.ownerDocument || document;
            const candidates = doc.querySelectorAll(
                '.vjs-big-play-button, #playButton .bigPlayButton, .bigPlayButton.pointer, .vjs-play-control'
            );
            for (const b of candidates) {
                if (isVisible(b)) {
                    await Human.click(b);
                    return true;
                }
            }
        } catch (e) {}
        // 2) 降级：videojs API → 原生 play()
        try {
            const vjs = (mediaWin && typeof mediaWin.videojs === 'function') ? mediaWin.videojs
                : ((pageWin && typeof pageWin.videojs === 'function') ? pageWin.videojs : null);
            if (vjs) {
                const player = vjs('video') || vjs(media);
                if (player && typeof player.play === 'function') {
                    const p = player.play();
                    if (p && typeof p.catch === 'function') p.catch(() => {});
                    return true;
                }
            }
        } catch (e) {}
        try {
            const p = media.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (e) {}
        return false;
    };

    const stopQuizWait = (media) => {
        const cleanup = quizWaitCleanupMap.get(media);
        if (cleanup) { try { cleanup(); } catch (e) {} quizWaitCleanupMap.delete(media); }
    };

    const startQuizWait = (media, mediaDoc, mediaWin) => {
        stopQuizWait(media);
        let timer = null;
        let resumeTimer = null;
        let lastLog = 0;
        const cleanup = () => {
            if (timer) clearInterval(timer);
            if (resumeTimer) clearInterval(resumeTimer);
            timer = null;
            resumeTimer = null;
        };
        quizWaitCleanupMap.set(media, cleanup);

        const attemptPlay = async () => {
            await playMediaLikeHuman(media, mediaWin, mediaDoc);
        };

        // 弹题关闭后的恢复播放必须带重试：一次 play() 可能被自动播放策略拒绝，
        // 失败即卡死（视频永不结束 → 任务 Promise 永不 resolve → 不翻页）
        const startResumeRetry = () => {
            let attempts = 0;
            resumeTimer = setInterval(() => {
                try {
                    if (!media || !media.isConnected) { cleanup(); return; }
                    if (media.ended || !media.paused) {
                        if (resumeTimer) clearInterval(resumeTimer);
                        resumeTimer = null;
                        return;
                    }
                    if (findQuizOverlayInChain(mediaDoc)) {
                        // 恢复期间又弹新题：回到弹题等待（先清掉本定时器）
                        if (resumeTimer) clearInterval(resumeTimer);
                        resumeTimer = null;
                        log('恢复播放前又检测到弹题，重新进入自动作答', 'warning');
                        startQuizWait(media, mediaDoc, mediaWin);
                        return;
                    }
                    attempts++;
                    if (attempts > 12) {
                        if (resumeTimer) clearInterval(resumeTimer);
                        resumeTimer = null;
                        log('弹题后多次恢复播放失败，已交给媒体看护继续尝试（也可手动点击播放）', 'danger');
                        return;
                    }
                    if (attempts <= 3 || attempts % 4 === 0) {
                        log(`正在恢复播放（第 ${attempts} 次）...`, 'primary');
                    }
                    attemptPlay();
                } catch (e) {
                    if (resumeTimer) clearInterval(resumeTimer);
                    resumeTimer = null;
                }
            }, 2500);
        };

        const tick = () => {
            if (!Settings.cx) { cleanup(); return; }
            if (!media || media.ended || !media.paused) { cleanup(); return; }
            const blocked = findQuizOverlayInChain(mediaDoc);
            if (!blocked) {
                cleanup();
                log('弹题已完成，自动恢复播放', 'success');
                attemptPlay();
                startResumeRetry(); // 关键：带重试，而不是只试一次
                return;
            }
            const now = Date.now();
            if (now - lastLog > 20000) {
                lastLog = now;
                log(`答题弹窗仍开启（${blocked.desc}），自动作答中/等待弹窗关闭，暂不恢复播放`, 'warning');
            }
            if (!AnswerBot.working && now - AnswerBot.lastRun > 2500) {
                AnswerBot.start(blocked);
            }
        };

        timer = setInterval(tick, 500);
        tick();
    };

    const processMedia = (mediaType, iframeDocument, iframeWindow) => new Promise((resolve) => {
        log(`正在加载 ${mediaType} 资源...`, 'primary');
        let retryCount = 0;
        let resolved = false;
        let watchdogRef = null;

        const finish = (media, msg) => {
            if (resolved) return;
            resolved = true;
            if (watchdogRef) { clearInterval(watchdogRef); watchdogRef = null; }
            stopQuizWait(media);
            log(msg || `${mediaType} 播放完毕`, 'success');
            resolve();
        };

        const checkAndPlay = setInterval(async () => {
            const media = iframeDocument.documentElement.querySelector(mediaType);
            if (!media) {
                if (retryCount++ > 60) {
                    clearInterval(checkAndPlay);
                    if (!resolved) { resolved = true; resolve(); }
                }
                return;
            }
            clearInterval(checkAndPlay);
            log(`${mediaType} 解析成功，开始静音播放`, 'primary');
            await playMediaLikeHuman(media, iframeWindow);

            let resumeTimer = null;
            let benignAttempts = 0;

            const scheduleResume = () => {
                clearTimeout(resumeTimer);
                resumeTimer = setTimeout(async () => {
                    if (!media || media.ended || !media.paused) return;
                    const blocked = findQuizOverlayInChain(iframeDocument);
                    if (blocked) {
                        log(`检测到弹题（${blocked.desc}），暂停自动恢复，转自动作答`, 'warning');
                        startQuizWait(media, iframeDocument, iframeWindow);
                        return;
                    }
                    benignAttempts++;
                    if (benignAttempts > 3) {
                        log('持续恢复播放失败，请点击页面任意处（弹题等待逻辑不受影响）', 'danger');
                        return;
                    }
                    log('正在恢复播放...', 'primary');
                    await playMediaLikeHuman(media, iframeWindow);
                }, 3000);
            };

            media.addEventListener('pause', () => {
                if (media.ended || resolved) return;
                clearTimeout(resumeTimer);
                const blocked = findQuizOverlayInChain(iframeDocument);
                if (blocked) {
                    log(`检测到弹题（${blocked.desc}），暂停自动恢复，开始自动作答`, 'warning');
                    startQuizWait(media, iframeDocument, iframeWindow);
                    return;
                }
                log(`检测到 ${mediaType} 暂停，3秒后将自动恢复播放`, 'warning');
                scheduleResume();
            });

            media.addEventListener('play', () => {
                clearTimeout(resumeTimer);
                stopQuizWait(media);
            });

            media.addEventListener('ended', () => finish(media));
            media.onended = () => finish(media);

            // 看护兜底：ended 事件可能在监听器挂上前已触发（如 AI 长等待期间视频自然放完），
            // 或媒体节点被页面移除。轮询兜底防止 Promise 永不 resolve → 不翻页。
            watchdogRef = setInterval(() => {
                if (resolved) { clearInterval(watchdogRef); watchdogRef = null; return; }
                try {
                    if (media.ended) {
                        clearInterval(watchdogRef); watchdogRef = null;
                        finish(media, `${mediaType} 已结束（看护触发）`);
                        return;
                    }
                    if (!media.isConnected) {
                        clearInterval(watchdogRef); watchdogRef = null;
                        finish(media, `${mediaType} 节点已被移除，视为任务完成`);
                        return;
                    }
                    const d = media.duration;
                    if (isFinite(d) && d > 0 && media.currentTime >= d - 1.2) {
                        clearInterval(watchdogRef);
                        watchdogRef = null;
                        finish(media, `${mediaType} 已播完（进度看护触发）`);
                    }
                } catch (e) {}
            }, 5000);

            const blockedNow = findQuizOverlayInChain(iframeDocument);
            if (blockedNow) {
                log(`${mediaType} 加载完成但检测到弹题，先自动作答再播放`, 'warning');
                startQuizWait(media, iframeDocument, iframeWindow);
            } else {
                await playMediaLikeHuman(media, iframeWindow);
                scheduleResume(); // 若因自动播放策略未真正开始，3秒后重试
            }
        }, 1000);
    });

    /* ================= PPT/PDF 自动翻阅 ================= */
    const processPpt = async (iframeWindow) => {
        log("发现文档任务，正在自动翻阅...", "warning");
        try {
            const panViewIframe = iframeWindow.document.querySelector('#panView, #pdfView, #panViewFrame, .panViewFrame, iframe[src*="pan"], iframe[src*="pdf"]');
            if (!panViewIframe) {
                log("未找到文档查看器，跳过该文档任务", "danger");
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
            log("文档（PPT/PDF）翻阅完成", "success");
        } catch (e) {
            log("文档任务处理异常，尝试继续下一任务", "danger");
        }
        return Promise.resolve();
    };

    /* ================= 章节任务点（作业/测验）处理 =================
     * 需求（用户明确）：学习通章节任务点要自动作答，但**只点「保存」、绝不点「提交」**。
     *   - 只保存 = 题目做完了但不算最终提交，学生可自己检查后再决定是否提交（更安全）
     *   - 因此本函数对「提交/交卷」类按钮一律不动，只找「保存/暂存」按钮
     */
    const findSaveBtn = (doc, rootEl) => {
        // 严格只要"保存/暂存"，绝不匹配"提交/交卷"
        let hit = null;
        eachDoc(doc, rootEl, (root) => {
            if (hit) return;
            try {
                const cands = root.querySelectorAll('a, button, input[type="button"], .btn, .jb_btn, [class*="save" i], [id*="save" i]');
                for (const el of cands) {
                    if (!isVisible(el)) continue;
                    const t = normalizeText(el.textContent || el.value || '');
                    if (!t) continue;
                    // 明确的排除：任何含"提交/交卷/递交/发布"的都不点
                    if (/提交|交卷|递交|发布|上交/.test(t)) continue;
                    if (/保存|暂存|存草稿/.test(t)) { hit = el; return; }
                }
            } catch (e) {}
        });
        return hit;
    };

    // 识别是否为作业/测验页（iframe 内出现题目容器即可判定）
    const isHomeworkDoc = (doc) => {
        try {
            return !!doc.querySelector(
                '.questionLi, .TiMu, .question-item, .exam-question, .mark_item, .ans-quest,'
                + ' .questionTitle, .queStem, .subject_describe, .marking_title,'
                + ' [class*="questionList" i], [class*="question-li" i], [class*="examQuestion" i]'
            );
        } catch (e) { return false; }
    };

    /**
     * 处理一个作业/测验任务点：逐题作答 → 只点保存。
     * 返回 true 表示处理过（无论成功与否），false 表示当前 iframe 不是作业页。
     */
    const processHomework = async (doc, win) => {
        if (!isHomeworkDoc(doc)) return false;
        log("发现章节任务点（作业/测验），开始自动作答（仅保存，不提交）", "warning");

        // 收集题目：优先常见题目容器，退化到逐一枚举选项组
        let questions = [];
        try {
            questions = Array.from(doc.querySelectorAll(
                '.questionLi, .TiMu, .question-item, .exam-question, .mark_item, .ans-quest,'
                + ' [class*="questionList" i] > li, [class*="question-li" i]'
            )).filter(isVisible);
        } catch (e) {}

        let answered = 0;
        if (questions.length) {
            for (const q of questions) {
                try {
                    const qText = getQuestionText(findQuestionEl(doc, q));
                    const options = collectOptions(doc, q);
                    const blanks = [];
                    try { blanks.push(...Array.from(q.querySelectorAll('input[type="text"], textarea')).filter(isVisible)); } catch (e) {}

                    let picks = [];
                    const local = localConfiguredAnswer(qText, options);
                    if (local && local.length) picks = options.filter(o => local.some(a => matchAnswer(o, a)));
                    if (!picks.length && Settings.aiEnabled && options.length) {
                        const ans = await aiAnswer(qText, options);
                        if (ans && ans.length) picks = options.filter(o => ans.some(a => matchAnswer(o, a)));
                    }
                    if (picks.length) {
                        for (const p of picks) { await Human.click(p.el); await Human.pause(); }
                        answered++;
                    } else if (blanks.length) {
                        // 填空：无法确定答案时留空（不猜，避免乱填触发异常）
                    }
                    await sleep(randInt(8, 18) / 10);   // 真人节奏：题间 0.8~1.8s
                } catch (e) {}
            }
        } else {
            // 未识别到题目容器：退化处理——把可见的选项组各选第一个"能匹配的答案"
            try {
                const optionEls = Array.from(doc.querySelectorAll('.ans-videoquiz-opt, label, [class*="option" i]')).filter(isVisible);
                if (!optionEls.length) {
                    log("任务点页未发现可作答内容，仅执行保存", "warning");
                }
            } catch (e) {}
        }

        log(`任务点作答完成（作答 ${answered} 题），准备保存（不会点提交）`, answered ? "success" : "warning");

        // 只保存，绝不提交
        const saveBtn = findSaveBtn(doc, doc.body);
        if (!saveBtn) {
            log("未找到「保存」按钮（已跳过提交，绝不自动交卷）", "warning");
            return true;
        }
        await Human.click(saveBtn);
        await sleep(randInt(20, 40) / 10);
        log("已点击保存（未提交，可自行检查后手动交卷）", "success");
        return true;
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

    const goToNextChapter = async () => {
        if (!Settings.cx) return;
        if (!Logger) Logger = ensureLogger();   // 防 Logger 未初始化时崩溃
        const nextBtnStatus = document.querySelector("#prevNextFocusNext");
        if (!nextBtnStatus || nextBtnStatus.style.display === "none") {
            log("已经到达最后一章节，无法跳转", "danger");
        } else {
            const nextClickBtn = document.querySelector(".jb_btn.jb_btn_92.fr.fs14.nextChapter");
            if (nextClickBtn) {
                log("正前往下一章节...", "success");
                await Human.click(nextClickBtn);   // 真人点击（原来直接 .click()，漏走拟人层）
            } else {
                log("未找到下一章按钮元素，自动跳转失败", "danger");
            }
        }
    };

    let isProcessing = false;
    let currentTaskId = 0;

    const processIframeTask = async () => {
        if (!Settings.cx) return;
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
                    } else if (Settings.answerTask && isHomeworkDoc(doc)) {
                        // 章节任务点（作业/测验）：面板「任务点题目」开关打开时才处理；只保存不提交
                        processedIframes.add(iframe);
                        taskPromises.push(processHomework(doc, win));
                    }
                } catch (e) {}
            }

            if (taskPromises.length > 0) {
                log(`精准识别到 ${taskPromises.length} 个未完成多媒体任务，开始处理...`, "warning");
                await Promise.all(taskPromises);
            }

            if (thisTaskId !== currentTaskId) return;

            // 跳转前等待弹题完全关闭（自动作答进行中）
            if (isAnyQuizBlocked()) {
                log("存在未完成的答题弹窗，等待自动作答完成后跳转...", "warning");
                let lastLog = 0;
                while (thisTaskId === currentTaskId && Settings.cx && isAnyQuizBlocked()) {
                    await sleep(1);
                    const now = Date.now();
                    if (now - lastLog > 20000) {
                        lastLog = now;
                        log("仍在等待答题弹窗关闭（不会绕过）...", "warning");
                    }
                }
            }

            if (thisTaskId !== currentTaskId) return;

            log("已知多媒体任务处理完毕，跳过章节习题，前往下一节", "success");
            await sleep(3);
            // sleep 期间又弹新题：不要直接放弃，重新进入弹题等待，弹窗关闭后再跳转
            if (thisTaskId === currentTaskId && isAnyQuizBlocked()) {
                log("跳转前检测到新弹题，先完成作答再跳转（不会绕过）", "warning");
                let lastLog = 0;
                while (thisTaskId === currentTaskId && Settings.cx && isAnyQuizBlocked()) {
                    await sleep(1);
                    const now = Date.now();
                    if (now - lastLog > 20000) {
                        lastLog = now;
                        log("仍在等待新弹题关闭（不会绕过）...", "warning");
                    }
                }
            }
            if (thisTaskId !== currentTaskId) return;
            if (!isAnyQuizBlocked()) {
                await goToNextChapter();   // async（内部走 Human 真人点击）
            } else {
                log("跳转已取消（页面切换或弹窗未完成）", "danger");
                // 页面没切走但弹窗还在 → 3 秒后重新调度任务，避免无人翻页
                if (thisTaskId === currentTaskId) {
                    isProcessing = false;
                    setTimeout(processIframeTask, 3000);
                }
            }
        } finally {
            if (thisTaskId === currentTaskId) isProcessing = false;
        }
    };

    /* ================= 初始化：超星引擎 ================= */
    let cxStarted = false;
    const initChaoxing = () => {
        if (cxStarted) return;
        const url = window.location.href;
        if (!url.includes("studentstudy")) return;

        if (!url.includes("mooc2=1")) {
            window.location.href = url + (url.includes("?") ? "&" : "?") + "mooc2=1";
            return;
        }

        cxStarted = true;
        Logger = ensureLogger();
        log("超星引擎已就绪（面板可开关）", "success");

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
            log(reason, "primary");
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
                if (!Settings.cx) return;
                if (AnswerBot.working || Date.now() - AnswerBot.lastRun <= 2500) return;
                const blocked = isAnyQuizBlocked();
                if (blocked) AnswerBot.start(blocked);
            } catch (e) {}
        }, 800);

        setTimeout(processIframeTask, 4000);
    };

    /* ================= 优学院引擎（只学课件、默认只前 6 个专题、拟人节奏、不做题） ================= */
    const YXY = {
        MAX_CHAPTERS: 6,
        busy: false,
        stopLogged: false,
        lastModalKey: '',
        lastChapterIdx: -1,
        modalWaitStart: 0,
        dayLimitHit: false,   // 今日学习时长/任务点已达上限 → 停止，避免无效操作被风控
        keepAliveTimer: null,
        readyLogged: false,

        async tick() {
            if (!Settings.yxy || this.dayLimitHit) return;
            const chapters = Array.from(document.querySelectorAll('.catalog-list > .chapter-item'));
            if (!chapters.length) return;
            if (!Logger) Logger = ensureLogger();
            if (!this.readyLogged) {
                this.readyLogged = true;
                log('优学院引擎已就绪：仅前6专题、1倍速不拖进度、不做题、挂机防检测', 'success');
            }
            if (this.busy) return;
            this.busy = true;
            try {
                await this.handleModal();

                const active = document.querySelector('.page-name.active');
                if (!active) {
                    await this.handleStatPage(chapters);
                    return;
                }

                const chapterIdx = chapters.indexOf(active.closest('.chapter-item'));
                if (chapterIdx >= 0) this.lastChapterIdx = chapterIdx;
                const maxCh = Settings.limit6 ? this.MAX_CHAPTERS : Infinity;
                if (chapterIdx >= maxCh) {
                    if (!this.stopLogged) {
                        this.stopLogged = true;
                        log(`已到达第 ${maxCh} 个专题边界，停止自动学习（防反作弊；可在面板关闭“前6专题”限制）`, 'danger');
                    }
                    return;
                }
                this.stopLogged = false;

                if (active.classList.contains('complete')) {
                    await this.nextPage(active, chapters);
                    return;
                }

                const icon = active.querySelector('.page-icon i');
                const glyph = icon ? (icon.textContent || '').charCodeAt(0) : 0;
                const courseware = glyph === 0xe850 || glyph === 0xe851 || glyph === 0xe852;
                if (courseware) {
                    const shouldNext = await this.studyPage(active);
                    // studyPage 只负责“学完”；返回 true 表示可以翻页（此前漏了这一行导致已完成不跳转）
                    if (shouldNext !== false) {
                        const liveActive = document.querySelector('.page-name.active') || active;
                        await this.nextPage(liveActive, chapters);
                    }
                } else {
                    // 非课件页 = 练习/作业任务点。是否自动作答由面板“任务点题目”开关决定
                    if (Settings.answerTask) {
                        await this.answerTaskPage(active);
                    }
                    log('优学院：非课件页（练习/作业），短暂停留后跳过' + (Settings.answerTask ? '（已尝试任务点作答）' : '，不做题'), 'warning');
                    await sleep(randInt(20, 40) / 10);
                    await this.nextPage(active, chapters);
                }
            } catch (e) {
            } finally {
                this.busy = false;
            }
        },

        async studyPage(active) {
            // 等待页面组件渲染完成
            for (let i = 0; i < 50; i++) {
                if (!document.querySelector('.page-loader')) break;
                await sleep(0.2);
            }

            const media = this.findMedia();
            if (media) {
                log('优学院课件：开始播放（正常速度、不拖进度条）', 'primary');
                this.tryPlay(media); // 真人式：优先点可见播放控件，失败才 API 兜底

                const started = Date.now();
                let lastRecover = 0;
                while (Date.now() - started < 45 * 60 * 1000) {
                    // 开关关闭/达上限 → 立即退出（不点翻页）
                    if (!Settings.yxy || this.dayLimitHit) return false;

                    // 页面已经标识完成 → 学习完成，返回可翻页
                    if (this.pageDone(active)) { await sleep(randInt(10, 20) / 10); return true; }

                    // 页面已被切换（如自动跳到统计页/下一页）→ 直接交回调度
                    const activeNow = document.querySelector('.page-name.active');
                    if (!activeNow || activeNow !== active) return true;
                    if (document.querySelector('.stat-page') && isVisible(document.querySelector('.stat-page'))) return true;

                    // ended 及兜底（部分播放器不触发 ended，但 currentTime 已到结尾）
                    if (media.ended || (media.currentTime && media.duration && media.currentTime >= media.duration - 1)) {
                        await sleep(randInt(10, 20) / 10);
                        return true;
                    }
                    // 播放器节点已被移除（页面重建）→ 交回调度
                    if (!media.isConnected) return true;

                    if (this.hasBlockingModal()) {
                        const text = this.visibleModalText();
                        if (/上限|已达上限/.test(text)) {
                            await this.handleModal(); // 达上限 → 立即停止引擎
                            return false;
                        }
                        if (/进度条不能拖拽|视频观看时长/.test(text)) {
                            await this.handleModal(); // 首次观看提示：点“知道了”
                        } else {
                            // 题目/作业弹窗：不做题；等待 30 秒后选择离开跳过该页
                            if (!this.modalWaitStart) this.modalWaitStart = Date.now();
                            if (Date.now() - this.modalWaitStart > 30000) {
                                log('优学院：课件内题目弹窗（不做题），选择“确定离开”跳过该页', 'warning');
                                await this.handleModal();
                                return false; // 弹窗的“确定离开”已触发切换，不再额外翻页
                            }
                            await sleep(1);
                            continue;
                        }
                    } else {
                        this.modalWaitStart = 0;
                        if (media.paused && !media.ended) {
                            if (Date.now() - lastRecover > 5000) {
                                lastRecover = Date.now();
                                this.tryPlay(media); // 非弹窗暂停才恢复（如浏览器自动暂停）
                            }
                        }
                    }
                    await sleep(1);
                }
                return true; // 45 分钟看护超时也放行翻页，避免永久卡死
            }

            // 文档/图文课件：拟人停留 4~8 秒后翻页
            log('优学院文档/图文页：拟人停留后翻页', 'warning');
            await sleep(randInt(40, 80) / 10);
            return true;
        },

        findMedia() {
            try {
                const scroller = document.querySelector('.page-scroller') || document;
                const stack = [scroller];
                const seen = new Set();
                while (stack.length) {
                    const d = stack.pop();
                    if (!d || seen.has(d)) continue;
                    seen.add(d);
                    try {
                        const m = d.querySelector('video, audio');
                        if (m) return m;
                        for (const f of d.querySelectorAll('iframe')) {
                            if (f.contentDocument) stack.push(f.contentDocument);
                        }
                    } catch (e) {}
                }
            } catch (e) {}
            return null;
        },

        async tryPlay(media) {
            // 真人式：优先点页面可见的播放控件，失败才降级 API
            try {
                const candidates = document.querySelectorAll(
                    '.mejs__play > button, .mejs__overlay-play, .jw-icon-display, .vjs-big-play-button'
                );
                for (const btn of candidates) {
                    if (isVisible(btn)) {
                        await Human.click(btn);
                        return;
                    }
                }
            } catch (e) {}
            try {
                const p = media.play();
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (e) {}
        },

        pageDone(active) {
            try {
                const el = document.querySelector('.page-name.active') || active;
                return !!(el && el.classList.contains('complete'));
            } catch (e) { return false; }
        },

        hasBlockingModal() {
            try {
                return Array.from(document.querySelectorAll('.modal')).some(m => isVisible(m) || m.classList.contains('in'));
            } catch (e) { return false; }
        },

        visibleModalText() {
            try {
                const m = Array.from(document.querySelectorAll('.modal')).find(x => isVisible(x) || x.classList.contains('in'));
                return (m && (m.textContent || '')) || '';
            } catch (e) { return ''; }
        },

        async handleModal() {
            const modal = Array.from(document.querySelectorAll('.modal')).find(m => isVisible(m) || m.classList.contains('in'));
            if (!modal) { this.lastModalKey = ''; return; }
            const text = modal.textContent || '';
            const key = normalizeText(text).slice(0, 60);
            if (key && key === this.lastModalKey) return; // 同一弹窗只处理一次

            // 每日学习时长/任务点上限：不点击任何按钮，直接停止引擎（防无效操作被风控）
            if (/上限|已达上限|今日学习时长|今日任务点|无法完成任务点/.test(text)) {
                this.dayLimitHit = true;
                this.lastModalKey = key;
                log('优学院：今日学习时长/任务点已达上限，停止自动学习（防反作弊）', 'danger');
                return;
            }

            const btns = Array.from(modal.querySelectorAll('button, .btn-submit, .btn-hollow, a'));
            const pick = (words) => btns.find(b => {
                const t = normalizeText(b.textContent);
                return t && words.some(w => t.includes(w));
            });
            let target = null;
            // ====================================================================================
            if (/进度条不能拖拽|视频观看时长/.test(text)) target = pick(['知道了']) || pick(['确定']);
            else if (/确定要切换页面吗|题目没有完成/.test(text)) target = pick(['确定离开']) || pick(['确定']);
            else if (/请勿同时学习|检测到你正在学习其他页面/.test(text)) target = pick(['继续学习']) || pick(['返回课程章节']);
            else if (/重试/.test(text)) target = pick(['重试']);
            else target = pick(['知道了', '确定', '继续']);
            this.lastModalKey = key;
            if (target) {
                log(`优学院弹窗处理：${normalizeText(target.textContent).slice(0, 12)}`, 'warning');
                await Human.click(target); // 真人点击（坐标一致 + 轨迹）
                await sleep(randInt(10, 20) / 10);
            }
        },

        // 挂机检测防御：随机 25~45 秒沿曲线移动一次鼠标（真人轨迹，不是瞬移单点）
        startKeepAlive() {
            if (this.keepAliveTimer) return;
            const loop = () => {
                this.keepAliveTimer = setTimeout(async () => {
                    try {
                        if (Settings.yxy && !this.dayLimitHit) {
                            const tx = randInt(60, Math.max(120, (window.innerWidth || 1280) - 60));
                            const ty = randInt(60, Math.max(120, (window.innerHeight || 800) - 60));
                            await Human.move(tx, ty);
                        }
                    } catch (e) {}
                    loop();
                }, randInt(25, 45) * 1000);
            };
            loop();
        },

        // 任务点（练习/作业）自动作答：仅在面板“任务点题目”开启时调用。
        // 优学院题目元素较杂，这里做保守的通用处理：AI 优先，命中后点击选项并提交。
        async answerTaskPage(active) {
            try {
                log('任务点题目自动作答：识别题目中...', 'warning');
                // 等待题目渲染
                for (let i = 0; i < 20; i++) {
                    if (document.querySelector('.question-wrapper, .question-container, .ans-videoquiz, .topic-option-item, .el-radio, .el-checkbox')) break;
                    await sleep(0.3);
                }
                const optEls = Array.from(document.querySelectorAll(
                    '.question-wrapper .option, .question-container .option, .topic-option-item, .el-radio, .el-checkbox'
                )).filter(isVisible);
                if (!optEls.length) {
                    log('任务点未发现可作答选项（可能不在题目页或结构不支持）', 'warning');
                    return;
                }
                const options = optEls.map(el => ({ el: el.closest('label, .option, .el-radio, .el-checkbox') || el, text: normalizeText(el.textContent) })).filter(o => o.text);
                const qEl = document.querySelector('.question-title, .title-tit, .question-content, .stem, .topic-title');
                const qText = normalizeText((qEl && qEl.textContent) || '');

                let picks = [];
                const local = localConfiguredAnswer(qText, options);
                if (local && local.length) picks = options.filter(o => local.some(a => matchAnswer(o, a)));
                if (!picks.length && Settings.aiEnabled) {
                    // 开启 AI：只等 AI，不用猜测答案
                    const ans = await aiAnswer(qText, options);
                    if (ans && ans.length) picks = options.filter(o => ans.some(a => matchAnswer(o, a)));
                }
                if (!picks.length) {
                    log('任务点：无 AI 命中，跳过作答（不猜答案，避免风控）', 'warning');
                    return;
                }
                for (const p of picks) {
                    await sleep(randInt(12, 26) / 10); // 读选项
                    await Human.click(p.el);
                }
                await sleep(randInt(15, 30) / 10);
                const submit = Array.from(document.querySelectorAll('button, .btn, .el-button'))
                    .find(b => isVisible(b) && /提交|交卷|保存|确定/.test(b.textContent || ''));
                if (submit) {
                    await Human.click(submit);
                    log('任务点题目已提交', 'success');
                }
            } catch (e) {
                log('任务点作答异常：' + ((e && e.message) || e), 'danger');
            }
        },

        async nextPage(active, chapters) {
            if (!chapters) chapters = [];   // 防 chapters 为 null 时 indexOf 崩溃
            const maxCh = Settings.limit6 ? this.MAX_CHAPTERS : Infinity;
            const pages = Array.from(document.querySelectorAll('.catalog-list .page-name'));
            const idx = pages.indexOf(active);
            const next = idx >= 0 ? pages[idx + 1] : null;
            if (next) {
                const nextChIdx = chapters.indexOf(next.closest('.chapter-item'));
                if (nextChIdx >= maxCh) {
                    if (!this.stopLogged) {
                        this.stopLogged = true;
                        log(`下一页属于第 ${nextChIdx + 1} 个专题，超出前 ${maxCh} 个专题限制，停止（防反作弊）`, 'danger');
                    }
                    return;
                }
            } else {
                // 目录节点找不到（页面重建/统计页）：用章节统计页边界兜底
                const stat = document.querySelector('.stat-page');
                if (stat && stat.classList.contains('chapter-stat') && this.lastChapterIdx >= maxCh - 1) {
                    if (!this.stopLogged) {
                        this.stopLogged = true;
                        log(`已完成第 ${maxCh} 个专题，停止自动学习（防反作弊）`, 'success');
                    }
                    return;
                }
            }

            // 桌面/移动两种翻页按钮都兼容，优先点可见的那个
            const allBtns = Array.from(document.querySelectorAll('.next-page-btn, .mobile-next-page-btn'));
            const btn = allBtns.find(isVisible) || allBtns[0];
            if (!btn) return;
            await sleep(randInt(15, 35) / 10); // 1.5~3.5 秒拟人停顿
            const name = normalizeText(btn.textContent).slice(0, 20);
            log(`优学院翻页 → ${name || '下一页'}`, 'primary');
            await Human.click(btn);
            await sleep(randInt(15, 30) / 10);
        },

        async handleStatPage(chapters) {
            const maxCh = Settings.limit6 ? this.MAX_CHAPTERS : Infinity;
            const btn = document.querySelector('.stat-page button[data-bind*="goNextPage"]');
            if (!btn || !isVisible(btn)) return;

            // 章节统计页且已在第 6 个专题内 → 不跨入第 7 个专题
            const isChapterStat = !!document.querySelector('.stat-page.chapter-stat');
            if (isChapterStat && this.lastChapterIdx >= maxCh - 1) {
                if (!this.stopLogged) {
                    this.stopLogged = true;
                    log(`已完成第 ${maxCh} 个专题，停止自动学习（防反作弊）`, 'success');
                }
                return;
            }
            const unfinishedInLimit = chapters.slice(0, maxCh === Infinity ? chapters.length : maxCh)
                .some(ch => ch.querySelector('.page-name:not(.complete)'));
            if (!unfinishedInLimit) {
                if (!this.stopLogged) {
                    this.stopLogged = true;
                    log('前 6 个专题内已无未完成课件，停止（防反作弊）', 'success');
                }
                return;
            }
            await sleep(randInt(20, 40) / 10);
            log('优学院统计页：前往下一节', 'primary');
            await Human.click(btn);
            await sleep(randInt(15, 30) / 10);
        }
    };

    /* ================= 启动分发 ================= */
    const boot = () => {
        const host = (location.hostname || '').toLowerCase();
        const isChaoxingStudy = location.href.includes('/mycourse/studentstudy') || host.includes('chaoxing');
        if (isChaoxingStudy) {
            setInterval(() => { if (Settings.cx) initChaoxing(); }, 3000);
            initChaoxing();
        }

        if (host.includes('ulearning') || location.pathname.includes('learnCourse') || host.includes('moocpeople')) {
            setInterval(() => { YXY.tick(); }, 1500);
            setTimeout(() => YXY.tick(), 2000);
            YXY.startKeepAlive();
        }

    };

    // @run-at document-start 时 DOM 尚未就绪：等 body 可用再启动引擎
    // （面板/引擎都需要 document.body，过早启动会静默失效）
    const startWhenReady = () => {
        try {
            if (document.body) { boot(); return; }
        } catch (e) {}
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => { try { boot(); } catch (e) {} }, { once: true });
        } else {
            setTimeout(startWhenReady, 30);
        }
    };
    startWhenReady();

})();
