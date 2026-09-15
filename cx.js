// ==UserScript==
// @name         🥇网课小助手|超星学习通+优学院+知到(智慧树)
// @namespace    noshuang
// @version      0.6.6
// @author       Modified
// @description  ①超星：自动播放视频/音频、PPT/PDF翻阅、视频弹题自动作答。②优学院：仅自动学习课件前6专题、拟人节奏、不做题。③知到(智慧树)：视频自动学习、弹题自动作答、不拖进度不加速、拟人防检测。面板开关可持久化，支持自定义 AI 模型提供方(API/模型/思考强度)。
// @match        https://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://*.ulearning.cn/*
// @match        *://ulearning.cn/*
// @match        *://*/*learnCourse*
// @match        *://*.moocpeople.cn/*
// @match        *://studyh5.zhihuishu.com/videoStudy.html*
// @match        *://*.zhihuishu.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const isYxyHost = /ulearning/i.test(location.hostname || '');
    const isZhsHost = /zhihuishu/i.test(location.hostname || '');
    // 优学院/知到允许在 iframe 内运行（学习页可能在框架中）；超星仍只运行顶层
    if (window.top !== window.self && !isYxyHost && !isZhsHost) return;

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
        zhs: true,       // 知到(智慧树)引擎
        limit6: true,    // 优学院只学前 6 个专题
        answerPop: true, // 视频/课程中间弹题自动作答
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
        if (Logger) return Logger;
        if (!document.getElementById('nc-panel-style')) {
            const st = document.createElement('style');
            st.id = 'nc-panel-style';
            st.textContent = PANEL_CSS;
            (document.head || document.documentElement).appendChild(st);
        }

        const container = document.createElement('div');
        container.className = 'nc-panel';

        const header = document.createElement('div');
        header.className = 'nc-hd';
        header.innerHTML = `<span>网课小助手</span><span class="nc-tag">v0.6.6</span><span class="nc-min" title="折叠/展开">—</span>`;
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
                if (Logger) Logger.addLog((cb.checked ? '已开启：' : '已关闭：') + label, 'primary');
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
        secEngine.bd.appendChild(mkSwitch('知到', 'zhs', '智慧树/知到自动学习'));
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
                Logger.addLog(`复用 ${now - lastProbe.at < 60000 ? '60 秒内' : ''}已探测的 ${Settings.aiModels.length} 个模型`, 'primary');
                return;
            }
            probeBtn.disabled = true;
            const oldText = probeBtn.textContent;
            probeBtn.textContent = '探测中…';
            if (!Logger) ensureLogger();
            try {
                Logger.addLog(`正在探测模型：${Settings.aiBaseURL}`, 'primary');
                const r = await probeModels();
                Settings.aiModels = r.ids;
                Settings.aiModelMeta = r.meta;
                modelMeta = r.meta;
                saveSettings();
                lastProbe = { key: probeKey, at: Date.now() };
                renderModels(r.ids, Settings.aiModel);
                syncEffort();
                Logger.addLog(`探测成功：发现 ${r.ids.length} 个模型`, 'success');
            } catch (e) {
                Logger.addLog('模型探测失败：' + ((e && e.message) || e), 'danger');
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
        const effortOptionsFor = (model) => {
            const meta = (Settings.aiModelMeta || {})[model];
            return (meta && meta.efforts && meta.efforts.length) ? meta.efforts : AI_EFFORTS.slice();
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
            effortHint.textContent = `该模型支持思考等级：${opts.map(e => EFFORT_LABEL[e] || e).join(' / ')}（选“关闭思考”才是真正关闭）`;
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
        document.body.appendChild(container);

        let isDragging = false, offsetX, offsetY;
        header.onmousedown = (e) => {
            if (e.target.classList.contains('nc-min')) return;
            isDragging = true; offsetX = e.clientX - container.offsetLeft; offsetY = e.clientY - container.offsetTop;
        };
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            container.style.left = (e.clientX - offsetX) + 'px';
            container.style.top = (e.clientY - offsetY) + 'px';
            container.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { isDragging = false; });
        if (minBtn) {
            minBtn.addEventListener('click', () => {
                body.style.display = body.style.display === 'none' ? '' : 'none';
            });
        }

        const colors = { primary: '#2563eb', success: '#16a34a', warning: '#d97706', danger: '#dc2626' };

        Logger = {
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
            Logger.addLog(`面板配置已加载：AI=${Settings.aiEnabled ? '开' : '关'}｜模型=${Settings.aiModel || '(空)'}｜接口=${base || '(空)'}`, 'primary');
            if (Settings.aiEnabled && (!base || !Settings.aiModel)) {
                Logger.addLog('注意：AI 已开启但配置不完整，答题时会报“未配置完整”，请填写 BaseURL 并选择模型', 'warning');
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

    /* ================= AI 答题（OpenAI 兼容 /chat/completions，参考 DSH provider 配置） ================= */
    // AI 结果按题目缓存，避免每轮重试都重复请求同一题（也更像人：同一道题不会反复问）
    const aiCache = new Map();
    let aiInflight = null;         // 正在进行的 AI 请求（同一题并发去重）
    let aiInflightKey = '';
    // 熔断：Key/账户级错误（401/402/403/429）后暂停 AI 调用，避免每道题都白试一次
    let aiBlocked = { until: 0, reason: '', code: 0 };
    const AI_FATAL_CODES = [401, 402, 403, 429];

    /**
     * 构造思考参数。
     * - 模型不支持思考（efforts 仅 ['off'] 或空）：**不发送任何思考参数**，
     *   避免严格服务端因未知字段（reasoning_effort / enable_thinking）返回 400。
     * - 模型支持思考：off = 关闭思考（显式传参关闭），其余档位映射到对应强度。
     */
    const buildEffortParams = (effort, model) => {
        const meta = (Settings.aiModelMeta || {})[model];
        // 优先看探测得到的能力标记；没有标记时按“支持”处理（用户可自选）
        const adjustable = (meta && typeof meta.adjustable === 'boolean')
            ? meta.adjustable
            : true;
        // 不支持思考 / 未选择档位 → 完全不传思考相关参数，避免 400
        if (!adjustable || !effort) return {};

        if (effort === 'off') {
            // 支持思考的模型，选择“关闭”才是真正关闭思考
            return { reasoning_effort: 'none', enable_thinking: false };
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
            Logger.addLog(`AI 未配置完整：BaseURL=${base ? '已填' : '空'}｜模型=${model || '空'}。请在面板填写并点“探测”选择模型后重试`, 'danger');
            return null;
        }
        if (!window.fetch) { Logger.addLog('当前浏览器不支持 fetch，AI 不可用', 'danger'); return null; }

        const cacheKey = model + '|' + qText + '|' + options.map(o => o.text).join('|');
        if (aiCache.has(cacheKey)) return aiCache.get(cacheKey);          // 命中缓存，直接复用
        if (aiInflight && aiInflightKey === cacheKey) return aiInflight;  // 同一题并发去重

        const optLines = options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.text}`).join('\n');
        const prompt = `你在帮学生作答网课选择题（可能单选/多选/判断）。\n题目：${qText}\n选项：\n${optLines}\n\n只输出最终答案，不要解释。单选/判断输出一个字母；多选输出多个字母，用英文逗号分隔（如 A,C,D）。`;
        const effortParams = buildEffortParams(Settings.aiEffort, model);
        const basePayload = {
            model: model,
            messages: [
                { role: 'system', content: '你是精确的答题引擎，只输出答案，不输出任何解释。' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.2,
            stream: false
        };
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
                        Logger.addLog(`AI 不可用：${reason}${detail ? '｜' + detail : ''}。已暂停 AI 调用 ${mins} 分钟，后续改用排除法`, 'danger');
                    } else {
                        Logger.addLog(`AI 请求失败 HTTP ${code}（本轮跳过，转排除法）`, 'danger');
                    }
                    return null;
                }
                const data = await resp.json();
                const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
                const letters = String(content).trim().toUpperCase().match(/[A-H]/g);
                if (letters && letters.length) {
                    const texts = letters.map(l => options[l.charCodeAt(0) - 65] ? options[l.charCodeAt(0) - 65].text : l).filter(Boolean);
                    Logger.addLog(`AI 作答：${texts.join('、')}`, 'success');
                    aiCache.set(cacheKey, texts);
                    return texts;
                }
                Logger.addLog('AI 未返回可用选项（转排除法）', 'warning');
                return null;
            } catch (e) {
                const msg = (e && e.message) || e;
                if (/abort/i.test(String(msg))) {
                    Logger.addLog(`AI 超时（${Math.round(timeoutMs / 1000)}s 未返回），已降级为排除法继续作答`, 'warning');
                } else {
                    Logger.addLog('AI 请求异常：' + msg + '（转排除法）', 'danger');
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
        // 推断思考能力（参考 DSH 对 reasoning 模型的标注）：
        // adjustable=true  → 可调档位（off/low/medium/high/max）
        // adjustable=false → 不支持思考（无档位可调），请求时不会携带任何思考参数
        // 若 /models 额外提供了 reasoning 能力字段，则优先采用服务端信息
        const meta = {};
        ids.forEach(item => {
            const id = typeof item === 'string' ? item : (item.id || item.name);
            const raw = typeof item === 'string' ? {} : item;
            let adjustable = null;
            // 服务端能力字段优先（不同厂商字段名不同）
            if (raw && (raw.reasoning === true || raw.supports_reasoning === true || raw.capabilities && raw.capabilities.reasoning)) {
                adjustable = true;
            } else if (raw && (raw.reasoning === false || raw.supports_reasoning === false)) {
                adjustable = false;
            }
            if (adjustable === null) {
                adjustable = /r1|reason|thinking|qwq|o1|o3|o4|deepseek-v3\.[12]\b|glm-4\.[56]|qwen3(?!-coder)/i.test(id);
            }
            meta[id] = {
                adjustable: adjustable,
                efforts: adjustable ? ['off', 'low', 'medium', 'high', 'max'] : []
            };
        });
        return { ids: ids.sort(), meta };
    };

    const getConfiguredAnswer = async (qText, options) => {
        const local = localConfiguredAnswer(qText, options);
        if (local) return { answer: local, fromConfig: true };
        const cfg = window.__CX_AUTO_ANSWER || {};
        if (typeof cfg.provider === 'function') {
            try {
                const ans = await cfg.provider(qText, options.map(o => o.text));
                if (ans) return { answer: Array.isArray(ans) ? ans.map(String) : [String(ans)], fromConfig: true };
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

        // 本地固定题库/provider 答案（瞬时）优先使用，不涉及 AI、不涉及猜测
        if (!state.cfgQueried) {
            state.cfgQueried = true;
            const local = localConfiguredAnswer(qText, options.concat(judge));
            state.cfgAnswer = local || null;
            state.cfgNeedProvider = !local && typeof (window.__CX_AUTO_ANSWER && window.__CX_AUTO_ANSWER.provider) === 'function';
        }
        if (!state.cfgAnswer && state.cfgNeedProvider && !state.cfgProviderLoading) {
            state.cfgProviderLoading = true;
            getConfiguredAnswer(qText, options.concat(judge)).then(res => {
                state.cfgAnswer = res ? res.answer : null;
                state.cfgProviderLoading = false;
            }).catch(() => { state.cfgProviderLoading = false; });
            Logger.addLog('正在通过自定义 provider 取答案...', 'primary');
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
                // 一直等 AI 返回（不设降级等待）；期间日志节流提示，避免刷屏
                if (!state.aiAnswer && state.aiPromise && !state.aiSettled) {
                    const waitLog = setInterval(() => {
                        if (state.aiAnswer || state.aiSettled) { clearInterval(waitLog); return; }
                        Logger.addLog('AI 思考中，保持等待（已禁用排除法，不会用猜测答案顶替）', 'primary');
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
                        Logger.addLog(`AI 未返回可用答案，本题改用排除法兜底${wait}`, 'warning');
                    }
                    state.aiFallback = true;
                } else {
                    state.aiTried = true;
                    const picks = (options.length ? options : judge).filter(o => state.aiAnswer.some(a => matchAnswer(o, a)));
                    if (picks.length) return { picks, fills: [] };
                    // AI 给的答案在选项中匹配不到 → 视为不可用
                    if (!state.aiFallback) Logger.addLog('AI 返回的答案无法匹配当前选项，改用排除法兜底', 'warning');
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
        // ======================================================================================
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
                // 失败提示节流（30s 一条），避免刷屏
                const nowLog = Date.now();
                if (state.cycleLogAt && nowLog - state.cycleLogAt < 30000) return false;
                state.cycleLogAt = nowLog;
                Logger.addLog(`自动作答暂停：${res.reason || '无可用选项'}`, 'danger');
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
            if (!Settings.cx) { cleanup(); return; }
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
        if (!Settings.cx) return;
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
                while (thisTaskId === currentTaskId && Settings.cx && isAnyQuizBlocked()) {
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
        Logger.addLog("超星引擎已就绪（面板可开关）", "success");

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
                Logger.addLog('优学院引擎已就绪：仅前6专题、1倍速不拖进度、不做题、挂机防检测', 'success');
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
                        Logger.addLog(`已到达第 ${maxCh} 个专题边界，停止自动学习（防反作弊；可在面板关闭“前6专题”限制）`, 'danger');
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
                    Logger.addLog('优学院：非课件页（练习/作业），短暂停留后跳过' + (Settings.answerTask ? '（已尝试任务点作答）' : '，不做题'), 'warning');
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
                Logger.addLog('优学院课件：开始播放（静音、正常速度、不拖进度条）', 'primary');
                try { media.muted = true; } catch (e) {}
                this.tryPlay(media);

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
                                Logger.addLog('优学院：课件内题目弹窗（不做题），选择“确定离开”跳过该页', 'warning');
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
            Logger.addLog('优学院文档/图文页：拟人停留后翻页', 'warning');
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

        tryPlay(media) {
            try {
                const p = media.play();
                if (p && typeof p.catch === 'function') p.catch(() => {
                    const btn = document.querySelector('.mejs__play > button, .mejs__overlay-play, .jw-icon-display, .vjs-big-play-button');
                    if (btn) clickEl(btn);
                });
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
                Logger.addLog('优学院：今日学习时长/任务点已达上限，停止自动学习（防反作弊）', 'danger');
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
                Logger.addLog(`优学院弹窗处理：${normalizeText(target.textContent).slice(0, 12)}`, 'warning');
                clickEl(target);
                await sleep(randInt(10, 20) / 10);
            }
        },

        // 挂机检测防御：随机 25~45 秒在页面内模拟一次鼠标移动（比参考脚本每秒一次的机械方案更拟人）
        startKeepAlive() {
            if (this.keepAliveTimer) return;
            const loop = () => {
                this.keepAliveTimer = setTimeout(() => {
                    try {
                        if (Settings.yxy && !this.dayLimitHit) {
                            document.dispatchEvent(new MouseEvent('mousemove', {
                                bubbles: true,
                                cancelable: true,
                                view: window,
                                clientX: randInt(40, Math.max(80, window.innerWidth - 40)),
                                clientY: randInt(40, Math.max(80, window.innerHeight - 40))
                            }));
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
                Logger.addLog('任务点题目自动作答：识别题目中...', 'warning');
                // 等待题目渲染
                for (let i = 0; i < 20; i++) {
                    if (document.querySelector('.question-wrapper, .question-container, .ans-videoquiz, .topic-option-item, .el-radio, .el-checkbox')) break;
                    await sleep(0.3);
                }
                const optEls = Array.from(document.querySelectorAll(
                    '.question-wrapper .option, .question-container .option, .topic-option-item, .el-radio, .el-checkbox'
                )).filter(isVisible);
                if (!optEls.length) {
                    Logger.addLog('任务点未发现可作答选项（可能不在题目页或结构不支持）', 'warning');
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
                    Logger.addLog('任务点：无 AI 命中，跳过作答（不猜答案，避免风控）', 'warning');
                    return;
                }
                for (const p of picks) {
                    await sleep(randInt(20, 40) / 10);
                    clickEl(p.el);
                }
                await sleep(randInt(15, 30) / 10);
                const submit = Array.from(document.querySelectorAll('button, .btn, .el-button'))
                    .find(b => isVisible(b) && /提交|交卷|保存|确定/.test(b.textContent || ''));
                if (submit) {
                    clickEl(submit);
                    Logger.addLog('任务点题目已提交', 'success');
                }
            } catch (e) {
                Logger.addLog('任务点作答异常：' + ((e && e.message) || e), 'danger');
            }
        },

        async nextPage(active, chapters) {
            const maxCh = Settings.limit6 ? this.MAX_CHAPTERS : Infinity;
            const pages = Array.from(document.querySelectorAll('.catalog-list .page-name'));
            const idx = pages.indexOf(active);
            const next = idx >= 0 ? pages[idx + 1] : null;
            if (next) {
                const nextChIdx = chapters.indexOf(next.closest('.chapter-item'));
                if (nextChIdx >= maxCh) {
                    if (!this.stopLogged) {
                        this.stopLogged = true;
                        Logger.addLog(`下一页属于第 ${nextChIdx + 1} 个专题，超出前 ${maxCh} 个专题限制，停止（防反作弊）`, 'danger');
                    }
                    return;
                }
            } else {
                // 目录节点找不到（页面重建/统计页）：用章节统计页边界兜底
                const stat = document.querySelector('.stat-page');
                if (stat && stat.classList.contains('chapter-stat') && this.lastChapterIdx >= maxCh - 1) {
                    if (!this.stopLogged) {
                        this.stopLogged = true;
                        Logger.addLog(`已完成第 ${maxCh} 个专题，停止自动学习（防反作弊）`, 'success');
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
            Logger.addLog(`优学院翻页 → ${name || '下一页'}`, 'primary');
            clickEl(btn);
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
                    Logger.addLog(`已完成第 ${maxCh} 个专题，停止自动学习（防反作弊）`, 'success');
                }
                return;
            }
            const unfinishedInLimit = chapters.slice(0, maxCh === Infinity ? chapters.length : maxCh)
                .some(ch => ch.querySelector('.page-name:not(.complete)'));
            if (!unfinishedInLimit) {
                if (!this.stopLogged) {
                    this.stopLogged = true;
                    Logger.addLog('前 6 个专题内已无未完成课件，停止（防反作弊）', 'success');
                }
                return;
            }
            await sleep(randInt(20, 40) / 10);
            Logger.addLog('优学院统计页：前往下一节', 'primary');
            clickEl(btn);
            await sleep(randInt(15, 30) / 10);
        }
    };

    /* ================= 知到(智慧树)引擎 =================
     * 反作弊要点（已确认）：
     *  - 页面 Object.freeze 冻结了 RegExp.test / Function.toString，禁止任何篡改原生方法；
     *  - 平台有"异常学习行为"检测，会锁定整门课程（dialog-aberrant）；
     *  - 弹题"未做答不能关闭"，必须真实作答；
     *  - 进度条 progressBall 不可拖拽，必须真实播放；
     *  - 有学习习惯分，禁止一次刷完所有课程。
     * 策略：只做"拟人化"操作——真实播放、随机停顿、单页面顺序、不加速不跳进度、不碰原生方法。
     */
    const ZHS = {
        busy: false,
        stopLogged: false,
        lastDialogKey: '',
        answering: false,
        planMap: null,
        keepAliveTimer: null,
        readyLogged: false,
        lockLogged: false,
        answeredCount: 0,

        // 课程被锁定的提示检测（出现即停止一切操作）
        isCourseLocked() {
            try {
                const aberrant = document.querySelector('.dialog-aberrant, .dialog .aberrant');
                if (aberrant && isVisible(aberrant)) return true;
                const t = document.body ? (document.body.innerText || '') : '';
                if (/平台监测到你存在异常学习行为|课程锁定|不再允许学习/.test(t)) return true;
            } catch (e) {}
            return false;
        },

        // 检测弹题（知到新版弹题运行时动态插入：.question-container/.answer-container；
        // 旧版为 .dialog-test 对话框或 iframe#tmDialog_iframe）
        findQuizDialog() {
            try {
                // 新版：题目卡片容器（CSS 中确认存在的真实类名）
                const newBox = document.querySelector('.question-container, .answer-container, .question');
                if (newBox && isVisible(newBox) && newBox.querySelector('.options .option, .option')) return newBox;

                // 旧版：Element UI 对话框
                const dialogs = Array.from(document.querySelectorAll('.el-dialog__wrapper.dialog-test, .dialog-test'));
                for (const d of dialogs) {
                    if (isVisible(d)) return d;
                }

                // 旧版：iframe#tmDialog_iframe
                const ifr = document.getElementById('tmDialog_iframe');
                if (ifr && ifr.contentDocument) {
                    const w = ifr.contentDocument.querySelector('.answerOption label, .option');
                    if (w) return ifr.contentDocument.body;
                }
            } catch (e) {}
            return null;
        },

        // 从可用 DOM 中收集题目与选项（覆盖新版 .question-container/.options .option 与旧版结构）
        collectQuiz(dialog) {
            const doc = dialog.ownerDocument || document;
            let root = dialog;
            let optEls = [];
            let qEl = null;
            const OPT_SEL = [
                '.question-container .options .option',
                '.options .option',
                '.topic-list .topic-option-item',
                '.topic-option-item',
                '.answerOption label',
                '.option'
            ].join(',');
            const tryRoot = (r) => {
                if (!r || !r.querySelectorAll) return false;
                const opts = Array.from(r.querySelectorAll(OPT_SEL)).filter(isVisible);
                if (opts.length) {
                    optEls = opts;
                    qEl = r.querySelector('.question-container .title, .title-tit, .topic-title, .question-title, .question-content, h3, .el-dialog__title') || qEl;
                    return true;
                }
                try {
                    for (const f of r.querySelectorAll('iframe')) {
                        if (f.contentDocument && tryRoot(f.contentDocument.body)) return true;
                    }
                } catch (e) {}
                return false;
            };
            tryRoot(root);
            // 兼容旧版 #tmDialog_iframe
            if (!optEls.length) {
                try {
                    const ifr = document.getElementById('tmDialog_iframe');
                    if (ifr && ifr.contentDocument) tryRoot(ifr.contentDocument.body);
                } catch (e) {}
            }
            const qText = normalizeText((qEl && qEl.textContent) || '');
            const options = optEls.map(el => ({ el, text: normalizeText(el.textContent) })).filter(o => o.text);
            const typeText = (qEl && qEl.textContent) || '';
            // 题型：题干标注 > input 类型 > 选项数量推断
            const hasCheckbox = optEls.some(el => el.querySelector && el.querySelector('input[type="checkbox"]'));
            const isMulti = /多选题|多选|多项/.test(typeText) || hasCheckbox;
            const isJudge = /判断题|判断/.test(typeText) ||
                (options.length === 2 && options.every(o => /^(对|错|正确|错误|是|否|√|×|T|F)$/i.test(o.text)));
            return { doc, root, qText, options, isMulti, isJudge };
        },

        // 未作答判定：知到提示“未做答的弹题不能关闭”，据此确认弹题仍待处理
        isUnansweredQuiz() {
            try {
                const boxes = Array.from(document.querySelectorAll('.el-message-box__wrapper, .el-message-box'));
                return boxes.some(b => isVisible(b) && /未做答的弹题不能关闭|未作答/.test(b.textContent || ''));
            } catch (e) {}
            return false;
        },

        async tick() {
            if (!Settings.zhs) return;
            if (!document.querySelector('.videoArea, #vjs_container, #nextBtn, ul.list li.video')) return;
            if (!Logger) Logger = ensureLogger();
            if (!this.readyLogged) {
                this.readyLogged = true;
                Logger.addLog('知到(智慧树)引擎已就绪：真实播放/不加速/不拖进度/拟人操作', 'success');
            }
            if (this.isCourseLocked()) {
                if (!this.lockLogged) {
                    this.lockLogged = true;
                    Logger.addLog('检测到平台"异常行为"锁定提示，已立即停止全部操作（请手动查看异常记录）', 'danger');
                }
                return;
            }
            if (this.busy) return;
            this.busy = true;
            try {
                // 1) 弹题优先（中间弹题）
                const dialog = this.findQuizDialog();
                if (dialog) {
                    if (Settings.answerPop) {
                        // 每轮只答一次，后续轮次由 tick 继续推进（轮间天然有 1.5s+ 间隔，避免高频提交）
                        await this.answerQuiz(dialog);
                    } else if (!this.warnedPopOff) {
                        this.warnedPopOff = true;
                        Logger.addLog('检测到弹题，但"课程中间弹题"开关已关闭（未做答不能关闭，请手动处理）', 'warning');
                    }
                    if (this.isCourseLocked()) return;
                    // 有弹题时不再推进播放/翻页，等待本题处理完
                    return;
                } else {
                    this.warnedPopOff = false;
                }

                // 2) 播放控制：真实播放、保持不暂停
                const media = document.getElementById('vjs_container_html5_api') ||
                    document.querySelector('.videoArea video, video');
                const bigPlay = document.querySelector('#playButton .bigPlayButton, .bigPlayButton.pointer, .vjs-big-play-button');
                if (media) {
                    if (bigPlay && isVisible(bigPlay)) {
                        clickEl(bigPlay); // 拟人点击播放按钮
                    } else if (media.paused && !media.ended) {
                        try { media.play && media.play().catch(() => {}); } catch (e) {}
                    }
                }

                // 3) 本节完成 → 下一节（真实进度到达，不拖拽）
                if (this.isLessonFinished(media)) {
                    await this.nextLesson();
                }
            } catch (e) {
            } finally {
                this.busy = false;
            }
        },

        isLessonFinished(media) {
            try {
                if (media && media.duration && media.currentTime >= media.duration - 1) return true;
                const pass = document.querySelector('.progress .passTime');
                const passWidth = pass ? parseFloat(pass.style.width || '0') : 0;
                // 智慧树进度条为百分比数值
                if (passWidth >= 98) return true;
                const txt = pass ? (pass.style.width || '') : '';
                if (/9[89](\.\d+)?%/.test(txt)) return true;
            } catch (e) {}
            return false;
        },

        async nextLesson() {
            if (!Settings.zhs) return;
            if (this.isCourseLocked()) return;
            const btn = document.getElementById('nextBtn');
            if (!btn) {
                if (!this.stopLogged) {
                    this.stopLogged = true;
                    Logger.addLog('已到最后一节（无下一节按钮），停止。建议分多天学习以保留学习习惯分', 'success');
                }
                return;
            }
            await sleep(this.realDelay() / 1000);
            Logger.addLog('本节播放完成，前往下一节', 'primary');
            clickEl(btn);
            await sleep(randInt(25, 45) / 10);
        },

        /**
         * 组合枚举：返回按规模递增的组合序列（1项 → 2项 → 3项 → …），
         * 用于多选题的分层遍历；上限 comboCap 防止组合爆炸。
         */
        buildCombos(optionsLen, comboCap) {
            const idx = Array.from({ length: optionsLen }, (_, i) => i);
            const combos = [];
            const pick = (start, cur) => {
                if (cur.length) combos.push(cur.slice());
                if (cur.length >= optionsLen) return;
                for (let i = start; i < idx.length; i++) {
                    cur.push(idx[i]);
                    pick(i + 1, cur);
                    cur.pop();
                }
            };
            pick(0, []);
            combos.sort((a, b) => a.length - b.length);
            return combos.slice(0, comboCap);
        },

        /**
         * 某题的遍历计划（关闭 AI 时的兜底，也用于 AI 未命中后的重试）。
         * - 单选/判断：每个选项各试一次（n 种）
         * - 多选：按 1项→2项→…→全选 分层遍历（受 comboCap 限制）
         * 计划缓存在 this.planMap[qKey]，跨轮次续走、不重复提交。
         */
        getQuizPlan(info, qKey) {
            if (!this.planMap) this.planMap = new Map();
            let plan = this.planMap.get(qKey);
            if (plan) return plan;
            const n = info.options.length;
            const comboCap = 16; // 单题最多尝试 16 种组合，避免高频提交被风控
            const combos = info.isMulti
                ? this.buildCombos(n, comboCap)
                : Array.from({ length: n }, (_, i) => [i]);
            plan = { combos, cursor: 0, fails: 0, done: false };
            this.planMap.set(qKey, plan);
            // 控制缓存规模
            if (this.planMap.size > 20) {
                const firstKey = this.planMap.keys().next().value;
                this.planMap.delete(firstKey);
            }
            return plan;
        },

        // 拟人勾选：先清空已选项，再点目标选项
        async selectOptions(info, picks) {
            try {
                info.root.querySelectorAll(
                    '.options .option.active, .options .option.selected, .topic-option-item.active, .option.selected, [class*="selected"]'
                ).forEach(el => clickEl(el));
            } catch (e) {}
            for (const p of picks) {
                await sleep(randInt(15, 35) / 10);
                clickEl(p.el);
            }
            await sleep(this.realDelay() / 1000);
        },

        // 弹题作答：优先 AI；AI 关闭/未命中 → 分层遍历兜底（可完整遍历，逐轮推进不重复）
        // 注意：同一题的后续轮次由 tick 反复调用本函数推进，因此不能用题目 key 做防并发，
        //       必须用「本轮是否仍在执行」布尔标志（answering）。
        async answerQuiz(dialog) {
            if (this.answering) return; // 上一轮尚未结束
            const info = this.collectQuiz(dialog);
            if (!info.options.length) return;
            this.answering = true;
            const qKey = this.qKeyOf(info);
            try {
                this.answeredCount++;
                const typeName = info.isMulti ? '多选' : info.isJudge ? '判断' : '单选';
                Logger.addLog(`知到弹题(${typeName})：${info.qText.slice(0, 40) || '(未识别题干)'}`, 'warning');

                // 本地配置答案（瞬时）优先；开启 AI 时禁用排除法：只等 AI，不用猜测答案。
                let picks = null;
                let viaAI = false;
                let aiUnavailable = false;
                const local = localConfiguredAnswer(info.qText, info.options);
                if (local && local.length) {
                    const hit = info.options.filter(o => local.some(a => matchAnswer(o, a)));
                    if (hit.length) picks = hit;
                }
                if (!picks && Settings.aiEnabled) {
                    if (!this.aiByKey) this.aiByKey = new Map();
                    let rec = this.aiByKey.get(qKey);
                    if (!rec) {
                        rec = { answer: null, promise: null, tried: false, settled: false };
                        rec.promise = aiAnswer(info.qText, info.options)
                            .then(ans => { rec.answer = ans || null; rec.settled = true; return ans; })
                            .catch(() => { rec.answer = null; rec.settled = true; return null; });
                        this.aiByKey.set(qKey, rec);
                        if (this.aiByKey.size > 20) this.aiByKey.delete(this.aiByKey.keys().next().value);
                    }
                    if (!rec.tried) {
                        if (!rec.answer && rec.promise) {
                            const waitLog = setInterval(() => {
                                if (rec.answer || rec.settled) { clearInterval(waitLog); return; }
                                Logger.addLog('AI 思考中，保持等待（已禁用排除法）', 'primary');
                            }, 15000);
                            try { await rec.promise; } finally { clearInterval(waitLog); }
                        }
                        if (rec.answer && rec.answer.length) {
                            rec.tried = true;
                            const hit = info.options.filter(o => rec.answer.some(a => matchAnswer(o, a)));
                            if (hit.length) { picks = hit; viaAI = true; }
                            else { Logger.addLog('AI 答案无法匹配选项，改用遍历兜底', 'warning'); aiUnavailable = true; }
                        } else {
                            if (!rec.warned) {
                                rec.warned = true;
                                const wait = aiBlocked.until > Date.now()
                                    ? `（AI 熔断中：${aiBlocked.reason || 'Key/账户不可用'}）` : '';
                                Logger.addLog(`知到：AI 未返回可用答案，改用遍历兜底${wait}`, 'warning');
                            }
                            aiUnavailable = true; // AI 明确不可用 → 才允许遍历
                        }
                    } else {
                        // 本题 AI 已答过且提交未通过 → AI 也拿不准，禁用遍历猜答案，停等人工
                        if (!rec.warnedFail) {
                            rec.warnedFail = true;
                            Logger.addLog('AI 作答未通过，已禁用排除法（避免反复试错触发风控，请人工处理）', 'danger');
                        }
                        return;
                    }
                }
                if (viaAI) Logger.addLog(`弹题 AI 命中：${picks.map(p => p.text).join('、')}`, 'success');

                // 遍历只在「未开启AI」或「AI 明确不可用」时使用；AI 开启且可用时绝不猜答案
                if (!picks) {
                    if (Settings.aiEnabled && !aiUnavailable) {
                        Logger.addLog('AI 尚未给出答案，保持等待（已禁用排除法，不会用猜测答案顶替）', 'warning');
                        return;
                    }
                    const plan = this.getQuizPlan(info, qKey);
                    if (plan.done || plan.cursor >= plan.combos.length) {
                        if (!plan.done) {
                            plan.done = true;
                            Logger.addLog(`知到弹题遍历已穷尽（${plan.combos.length} 种组合），停止自动作答，请手动完成`, 'danger');
                        }
                        return;
                    }
                    const combo = plan.combos[plan.cursor];
                    plan.cursor++;
                    picks = combo.map(i => info.options[i]).filter(Boolean);
                    Logger.addLog(`弹题遍历 ${plan.cursor}/${plan.combos.length}：${picks.map(p => p.text).join('、')}`, 'primary');
                }

                await this.selectOptions(info, picks);

                // 提交（提交后才会判定/关闭；按钮可能在弹窗 footer 或 iframe 内）
                const submit = this.findSubmitBtn(info);
                if (!submit) {
                    Logger.addLog('未找到知到弹题提交按钮，保持等待（不强行关闭）', 'warning');
                    return;
                }
                clickEl(submit);
                await sleep(randInt(30, 55) / 10); // 提交后等判定，拟人

                // 判定结果
                if (this.findQuizDialog()) {
                    // 仍在 → 视为答错
                    const plan = this.getQuizPlan(info, qKey);
                    plan.fails++;
                    if (viaAI) {
                        plan.cursor = 0; // AI 错了 → 交给遍历完整走一遍
                        Logger.addLog('AI 答案未通过，下一轮改用遍历兜底', 'warning');
                    } else {
                        Logger.addLog(`第 ${plan.cursor}/${plan.combos.length} 轮未通过，继续遍历下一种组合`, 'warning');
                    }
                    if (plan.cursor >= plan.combos.length) {
                        plan.done = true;
                        Logger.addLog('知到弹题遍历已穷尽，停止自动作答（请手动完成）', 'danger');
                    }
                } else {
                    Logger.addLog('弹题完成，弹窗已关闭', 'success');
                    if (this.planMap) this.planMap.delete(qKey);
                    this.lastDialogKey = '';
                }
            } finally {
                this.answering = false;
            }
        },

        qKeyOf(info) {
            return (info.qText || '') + '|' + info.options.map(o => o.text).join('|');
        },

        findSubmitBtn(info) {
            const texts = ['提交', '确定', '确认', '下一题', '提交答案'];
            const scan = (root) => {
                if (!root) return null;
                try {
                    const btns = Array.from(root.querySelectorAll('.el-dialog__footer button, .dialog-footer button, .dialog-footer .btn, button.btn, .el-button, button'));
                    return btns.find(b => isVisible(b) && texts.some(t => (b.textContent || '').indexOf(t) !== -1)) || null;
                } catch (e) { return null; }
            };
            let btn = scan(info.root);
            if (btn) return btn;
            // 兼容：兄弟节点中的 dialog footer，或 iframe 内
            try {
                btn = scan(document.querySelector('.el-dialog__wrapper.dialog-test .el-dialog__footer'
                    + ', .dialog-test .el-dialog__footer'));
                if (btn) return btn;
                const ifr = document.getElementById('tmDialog_iframe');
                if (ifr && ifr.contentDocument) btn = scan(ifr.contentDocument);
            } catch (e) {}
            return btn || null;
        },

        realDelay() { return Settings.humanize ? randInt(1500, 3500) : 600; },

        // 防挂机（比参考脚本每秒一次更拟人）
        startKeepAlive() {
            if (this.keepAliveTimer) return;
            const loop = () => {
                this.keepAliveTimer = setTimeout(() => {
                    try {
                        if (Settings.zhs && Settings.humanize && !this.isCourseLocked()) {
                            document.dispatchEvent(new MouseEvent('mousemove', {
                                bubbles: true, cancelable: true, view: window,
                                clientX: randInt(40, Math.max(80, window.innerWidth - 40)),
                                clientY: randInt(40, Math.max(80, window.innerHeight - 40))
                            }));
                        }
                    } catch (e) {}
                    loop();
                }, randInt(25, 45) * 1000);
            };
            loop();
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

        if (host.includes('zhihuishu')) {
            setInterval(() => { ZHS.tick(); }, 1500);
            setTimeout(() => ZHS.tick(), 2500);
            ZHS.startKeepAlive();
        }
    };

    boot();

})();
