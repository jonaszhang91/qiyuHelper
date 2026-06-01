(function () {
    'use strict';

    // ========== 配置 ==========
    const CONFIG = {
        SCAN_INTERVAL: 5000,
        INIT_DELAY: 1500,
        COOLDOWN_MS: 6000,
        PARENT_CLASS: 'm-chat-sessionlist-item',
        MARKER_SELECTOR: '.bg-ysf-success',
        STORAGE_KEY: 'ysf_replied_ids_v5',
        KNOWN_STORAGE_KEY: 'ysf_known_sessions_v5',
        CLICK_DELAY: 600,
        INPUT_DELAY: 200,
        AFTER_SEND_DELAY: 700,
        QUICK_SCAN_DELAY: 2000
    };

    // ========== 全局状态 ==========
    let running = false;
    let intervalId = null;
    let uiUpdateInterval = null;
    let repliedIds = new Set();
    let processingIds = new Set();
    let cooldownIds = new Set();
    let knownSessions = new Set();
    let replyCount = 0;

    // ---------- 工具函数 ----------
    const delay = ms => new Promise(r => setTimeout(r, ms));

    function getSessionId (el) {
        let id = el.getAttribute('data-id');
        if (id && id.trim()) return 'id_' + id.trim();
        const title = el.querySelector('.truncate')?.innerText?.trim();
        return title ? 'title_' + title : null;
    }

    function getAllSessions () {
        return Array.from(document.getElementsByClassName(CONFIG.PARENT_CLASS));
    }

    // ---------- 数据持久化 ----------
    function saveReplied () {
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify([...repliedIds]));
    }
    function saveKnown () {
        localStorage.setItem(CONFIG.KNOWN_STORAGE_KEY, JSON.stringify([...knownSessions]));
    }
    function loadStorage () {
        try {
            const rep = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (rep) repliedIds = new Set(JSON.parse(rep));
            const known = localStorage.getItem(CONFIG.KNOWN_STORAGE_KEY);
            if (known) knownSessions = new Set(JSON.parse(known));
        } catch (e) { }
    }

    // ---------- 核心逻辑 ----------
    function getNewMarkedSessions () {
        const markers = document.querySelectorAll(CONFIG.MARKER_SELECTOR);
        const sessions = new Set();
        for (const marker of markers) {
            const text = marker.innerText.trim();
            if (text.toLowerCase() === 'new') {
                let parent = marker.closest(`.${CONFIG.PARENT_CLASS}`);
                if (parent) {
                    sessions.add(parent);
                } else {
                    parent = marker.closest('[data-id]');
                    if (parent) sessions.add(parent);
                }
            }
        }
        return Array.from(sessions);
    }

    function rebuildKnownSet () {
        knownSessions.clear();
        const items = getAllSessions();
        for (const el of items) {
            const uid = getSessionId(el);
            if (uid) knownSessions.add(uid);
        }
        saveKnown();
        addLog(`🏷️ 已知 ${knownSessions.size} 个会话（快照）`);
        updateCounts();
    }

    function addToKnown (el) {
        const uid = getSessionId(el);
        if (!uid) return;
        if (!knownSessions.has(uid)) {
            knownSessions.add(uid);
            saveKnown();
        }
    }

    function markReplied (el) {
        const uid = getSessionId(el);
        if (!uid) return false;
        el.setAttribute('data-ysf-replied', 'true');
        if (!repliedIds.has(uid)) {
            repliedIds.add(uid);
            saveReplied();
        }
        if (!cooldownIds.has(uid)) {
            cooldownIds.add(uid);
            setTimeout(() => cooldownIds.delete(uid), CONFIG.COOLDOWN_MS);
        }
        addToKnown(el);
        replyCount++;
        updateCounts();
        return true;
    }

    function isReplied (el) {
        const uid = getSessionId(el);
        if (!uid) return false;
        if (el.getAttribute('data-ysf-replied') === 'true') return true;
        if (repliedIds.has(uid)) return true;
        if (cooldownIds.has(uid)) return true;
        return false;
    }

    function shouldReply (el) {
        const uid = getSessionId(el);
        if (!uid) return false;
        if (isReplied(el)) return false;
        return !knownSessions.has(uid);
    }

    async function processSession (el) {
        const uid = getSessionId(el);
        if (!uid || processingIds.has(uid)) return false;
        processingIds.add(uid);
        markReplied(el);
        console.log(`🔔 检测到新会话：${uid}`);
        el.click();
        await delay(CONFIG.CLICK_DELAY);
        const editor = await waitForElement('.ql-editor p', 4000);
        if (!editor) {
            processingIds.delete(uid);
            return false;
        }
        const replyMsg = document.getElementById('replyMsg')?.value || '您稍等，我来帮您看下';
        editor.textContent = replyMsg;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await delay(CONFIG.INPUT_DELAY);
        const sendBtn = await waitForElement('.ant-btn.ant-btn-primary', 3000);
        if (sendBtn) {
            sendBtn.click();
            console.log('📤 已发送自动回复');
            await delay(CONFIG.AFTER_SEND_DELAY);
        } else console.warn('❌ 未找到发送按钮');

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27 }));
        const mask = document.querySelector('.ant-modal-mask, .fishd-drawer-mask');
        if (mask) mask.click();
        await delay(400);
        processingIds.delete(uid);
        return true;
    }

    function waitForElement (selector, timeout = 5000) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = setInterval(() => {
                const el = document.querySelector(selector);
                if (el) {
                    clearInterval(check);
                    resolve(el);
                } else if (Date.now() - start > timeout) {
                    clearInterval(check);
                    resolve(null);
                }
            }, 200);
        });
    }

    async function performScan () {
        if (!running) return;
        const newMarkedSessions = getNewMarkedSessions();
        const targets = newMarkedSessions.filter(el => shouldReply(el));
        if (targets.length === 0) {
            updateCounts();
            return;
        }
        addLog(`⚡ 发现 ${targets.length} 新会话，开始处理...`);
        for (const el of targets) {
            if (!running) break;
            await processSession(el);
            await delay(200);
        }
        addLog('✅ 批量回复完成');
        updateCounts();
        if (running) setTimeout(() => performScan(), CONFIG.QUICK_SCAN_DELAY);
    }

    async function start () {
        if (running) return;
        running = true;
        addLog('⏳ 正在初始化已知会话列表...');
        await delay(CONFIG.INIT_DELAY);
        rebuildKnownSet();
        addLog('🚀 已启动 ');
        if (intervalId) clearInterval(intervalId);
        intervalId = setInterval(() => {
            if (running) performScan();
        }, CONFIG.SCAN_INTERVAL);
        performScan();
        if (uiUpdateInterval) clearInterval(uiUpdateInterval);
        uiUpdateInterval = setInterval(updateCounts, 1000);
        updateUI();
    }

    function stop () {
        running = false;
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
        if (uiUpdateInterval) {
            clearInterval(uiUpdateInterval);
            uiUpdateInterval = null;
        }
        addLog('⏹️ 已停止');
        updateUI();
    }

    function resetAll () {
        localStorage.removeItem(CONFIG.STORAGE_KEY);
        localStorage.removeItem(CONFIG.KNOWN_STORAGE_KEY);
        repliedIds.clear();
        knownSessions.clear();
        processingIds.clear();
        cooldownIds.clear();
        replyCount = 0;
        const items = getAllSessions();
        items.forEach(el => el.removeAttribute('data-ysf-replied'));
        rebuildKnownSet();
        updateCounts();
        addLog('🗑️ 已重置记录，当前所有会话视为已知');
        alert('重置完成！');
    }

    // =========================================================
    //  自动点击服务小记核心业务
    // =========================================================
    let clickLogBtn = () => {
        const logBtn = document.querySelector("#subapp-container > div.m-kefu-chat > div.m-chat-pannel > div.m-chat-pannel-info > div.flex.items-center.min-h-\\[60px\\] > div.btn-wrap > span:nth-child(3)");
        if(logBtn) logBtn.click();
    }

    let clickLogTextBtn = () => {
        const logTextBtn = document.querySelector(".Tabselect > div > div > div > div > div > span > span");
        if(logTextBtn) logTextBtn.click();
    }

    let autoClick = () => {
        clickLogBtn();
        setTimeout(() => {
            clickLogTextBtn();
        }, 500);
    }

    function clickCoordinate(x, y) {
        const target = document.elementFromPoint(x, y) || document.documentElement;
        const config = {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, screenX: x, screenY: y
        };
        target.dispatchEvent(new MouseEvent('mousedown', config));
        target.dispatchEvent(new MouseEvent('mouseup', config));
        target.dispatchEvent(new MouseEvent('click', config));
    }

    let clickTarge = async (n, m) => {
        autoClick();
        setTimeout(() => {
            const targeClass = 'Tabselect-muPopupContent-category-button';
            let els = document.querySelectorAll(`.${targeClass}>span`);
            if(els[n]) {
                els[n].click();
                setTimeout(() => {
                    els = document.querySelectorAll(`.${targeClass}>span`);
                    if(els[m]) {
                        els[m].click();
                        setTimeout(() => { clickCoordinate(50,50) }, 100);
                    }
                }, 100);
            }
        }, 500);
    }

    async function handleCustomOption1 () { addLog('⚙️ 触发：pos 设置'); clickTarge(3, 0); }
    async function handleCustomOption2 () { addLog('⚙️ 触发：刷卡机问题'); clickTarge(1, 14); }
    async function handleCustomOption3 () { addLog('⚙️ 触发：打印机问题'); clickTarge(4, 2); }
    async function handleCustomOption4 () { addLog('⚙️ 触发：其他'); clickTarge(8, 3); }

    // ---------- UI 辅助 ----------
    function updateCounts () {
        const totalEl = document.getElementById('totalCount');
        const pendingEl = document.getElementById('pendingCount');
        const repliedEl = document.getElementById('replyCount');
        if (!totalEl || !pendingEl || !repliedEl) return;
        const all = getAllSessions();
        const total = all.length;
        const newMarkedSessions = getNewMarkedSessions();
        const pending = newMarkedSessions.filter(el => shouldReply(el)).length;
        totalEl.innerText = total;
        pendingEl.innerText = pending;
        repliedEl.innerText = replyCount;
    }

    let lastLog = '就绪';
    function addLog (msg) {
        lastLog = msg;
        const logEl = document.getElementById('logLine');
        if (logEl) logEl.innerText = msg;
        console.log(msg);
    }

    // ========== 构建控制面板和动画样式 ==========
    const style = document.createElement('style');
    style.textContent = `
    @keyframes pulse-glow {
        0% { box-shadow: 0 0 5px rgba(0,255,200,0.6); }
        50% { box-shadow: 0 0 20px rgba(0,255,200,0.9),0 0 40px rgba(0,200,255,0.4); }
        100% { box-shadow: 0 0 5px rgba(0,255,200,0.6); }
    }
    .ysf-dropdown-item:hover, .ysf-right-menu-item:hover {
        background: rgba(0, 255, 200, 0.15) !important;
        color: #00ffc8 !important;
    }
    `;
    document.head.appendChild(style);

    const container = document.createElement('div');
    container.className = 'ysf-tech-panel';
    container.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:9999; pointer-events:none;';

    const floatingBtn = document.createElement('button');
    floatingBtn.id = 'floatingActionBtn';
    floatingBtn.style.cssText = `
    width:52px; height:52px; border-radius:50%; border:2px solid rgba(0,255,200,0.7); background:rgba(20,30,40,0.85); backdrop-filter:blur(12px); color:#00ffc8; font-size:24px; display:flex; align-items:center; justify-content:center; cursor:pointer; pointer-events:auto; animation:pulse-glow 2.5s infinite; transition:transform 0.2s; box-shadow:0 0 15px rgba(0,255,200,0.3);
    float: right;`;
    floatingBtn.innerHTML = '⚡';
    floatingBtn.title = '左键展开面板 | 右键快捷服务小记';

    // 创建右键菜单容器
    const rightClickMenu = document.createElement('div');
    rightClickMenu.id = 'floatingRightMenu';
    rightClickMenu.style.cssText = `
    display:none; position:fixed; width:130px; background:rgba(15,25,35,0.95); backdrop-filter:blur(10px); border:1px solid rgba(0,255,200,0.5); border-radius:12px; box-shadow:0 10px 25px rgba(0,0,0,0.5); overflow:hidden; z-index:10001; pointer-events:auto;
    `;
    rightClickMenu.innerHTML = `
        <div style="padding:6px 12px; font-size:10px; color:#78909c; background:rgba(0,255,200,0.05); border-bottom:1px solid rgba(0,255,200,0.2); font-weight:bold;">🚀 快捷记录</div>
        <div id="rightOpt1" class="ysf-right-menu-item" style="padding:8px 12px; color:#e0f7fa; font-size:12px; cursor:pointer; text-align:left; border-bottom:1px solid rgba(255,255,255,0.05);">pos 设置</div>
        <div id="rightOpt2" class="ysf-right-menu-item" style="padding:8px 12px; color:#e0f7fa; font-size:12px; cursor:pointer; text-align:left; border-bottom:1px solid rgba(255,255,255,0.05);">刷卡机问题</div>
        <div id="rightOpt3" class="ysf-right-menu-item" style="padding:8px 12px; color:#e0f7fa; font-size:12px; cursor:pointer; text-align:left; border-bottom:1px solid rgba(255,255,255,0.05);">打印机问题</div>
        <div id="rightOpt4" class="ysf-right-menu-item" style="padding:8px 12px; color:#e0f7fa; font-size:12px; cursor:pointer; text-align:left;">其他</div>
    `;
    document.body.appendChild(rightClickMenu);

    const panel = document.createElement('div');
    panel.id = 'techPanel';
    panel.style.cssText = `
    display:block; width:290px; background:rgba(10,20,30,0.85); backdrop-filter:blur(20px); border-radius:20px; border:1px solid rgba(0,255,200,0.25); box-shadow:0 20px 40px rgba(0,0,0,0.6),0 0 30px rgba(0,255,200,0.1); padding:18px; color:#e0f7fa; pointer-events:auto; margin-bottom:12px; transition:all 0.3s ease;
    opacity: 0; pointer-events:none;`;
    panel.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
        <span style="font-weight:700; font-size:16px; background:linear-gradient(90deg,#00ffc8,#00b4ff); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">◆ 七鱼·QueryAll</span>
        <span id="statusIndicator" style="font-size:11px; padding:2px 10px; border-radius:12px; background:rgba(255,255,255,0.1); color:#aaa;">离线</span>
    </div>
    <div style="display:flex; gap:8px; margin-bottom:12px;">
        <div style="flex:1; background:rgba(0,255,200,0.05); border-radius:12px; padding:10px; text-align:center;">
            <div style="font-size:10px; color:#78909c;">总会话</div>
            <div id="totalCount" style="font-size:22px; font-weight:700; color:#fff;">0</div>
        </div>
        <div style="flex:1; background:rgba(255,200,0,0.05); border-radius:12px; padding:10px; text-align:center;">
            <div style="font-size:10px; color:#78909c;">待处理(NEW)</div>
            <div id="pendingCount" style="font-size:22px; font-weight:700; color:#ffb300;">0</div>
        </div>
        <div style="flex:1; background:rgba(0,200,255,0.05); border-radius:12px; padding:10px; text-align:center;">
            <div style="font-size:10px; color:#78909c;">已回复</div>
            <div id="replyCount" style="font-size:22px; font-weight:700; color:#00b4ff;">0</div>
        </div>
    </div>
    <div style="margin-bottom:10px; display:flex; gap:6px; position:relative;">
        <button id="startStopBtn2" style="flex:2; padding:8px 0; border:none; border-radius:20px; font-weight:600; font-size:13px; background:linear-gradient(135deg,#00b4ff,#00ffc8); color:#0a141e; cursor:pointer;">▶ 启动</button>

        <div style="flex:1.5; position:relative;">
            <button id="customFuncBtn" style="width:100%; padding:8px 0; border:1px solid rgba(0,255,200,0.4); border-radius:20px; font-weight:600; font-size:12px; background:rgba(0,255,200,0.1); color:#00ffc8; cursor:pointer;" title="logBtn">⚙️ 服务小记 ▾</button>

            <div id="customDropdownMenu" style="display:none; position:absolute; bottom:110%; right:0; width:130px; background:rgba(15,25,35,0.95); backdrop-filter:blur(10px); border:1px solid rgba(0,255,200,0.4); border-radius:12px; box-shadow:0 10px 25px rgba(0,0,0,0.5); overflow:hidden; z-index:10000; transition:all 0.2s;">
                <div id="dropdownOpt1" class="ysf-dropdown-item" style="padding:8px 12px; color:#e0f7fa; font-size:12px; cursor:pointer; text-align:left; border-bottom:1px solid rgba(255,255,255,0.05);">pos 设置</div>
                <div id="dropdownOpt2" class="ysf-dropdown-item" style="padding:8px 12px; color:#e0f7fa; font-size:12px; cursor:pointer; text-align:left; border-bottom:1px solid rgba(255,255,255,0.05);">刷卡机问题</div>
                <div id="dropdownOpt3" class="ysf-dropdown-item" style="padding:8px 12px; color:#e0f7fa; font-size:12px; cursor:pointer; text-align:left; border-bottom:1px solid rgba(255,255,255,0.05);">打印机问题</div>
                <div id="dropdownOpt4" class="ysf-dropdown-item" style="padding:8px 12px; color:#e0f7fa; font-size:12px; cursor:pointer; text-align:left;">其他</div>
            </div>
        </div>

        <button id="resetBtn2" style="width:32px; border-radius:50%; border:1px solid rgba(255,255,255,0.2); background:transparent; color:#aaa; font-size:14px; cursor:pointer;" title="重置记录">↺</button>
    </div>
    <div style="margin-bottom:8px;">
        <label style="font-size:10px; color:#aaa;">回复文本</label>
        <input id="replyMsg" value="您稍等，我来帮您看下" style="width:100%; padding:6px 10px; background:rgba(255,255,255,0.08); border:1px solid rgba(0,255,200,0.3); border-radius:10px; color:#e0f7fa; font-size:12px; margin-top:2px; box-sizing:border-box;">
    </div>
    <div id="logLine" style="font-size:10px; color:#00ffc8; background:rgba(0,255,200,0.05); padding:4px 8px; border-radius:8px; min-height:16px; margin-bottom:4px;">就绪</div>
    <div style="text-align:right; font-size:9px; color:#546e7a;">遍历所有NEW标记 | querySelectorAll</div>
    `;

    container.appendChild(panel);
    container.appendChild(floatingBtn);
    document.body.appendChild(container);

    // ========== 事件监听 ==========

    let expanded = false;
    floatingBtn.addEventListener('click', (e) => {
        if (expanded) {
            panel.style.opacity = '0';
            panel.style.pointerEvents = 'none';
            floatingBtn.innerHTML = '⚡';
            expanded = false;
        } else {
            panel.style.opacity = '1';
            panel.style.pointerEvents = 'auto';
            floatingBtn.innerHTML = '✕';
            expanded = true;
            updateCounts();
            updateUI();
        }
    });

    // 🆕 【修改点二】：右键点击悬浮球时，让菜单精准生成在鼠标指针的“左上方”
    floatingBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // 核心数学偏移：鼠标横坐标减去菜单宽度(130px)，纵坐标减去菜单高度(约145px)
        const targetLeft = e.clientX - 130 - 5;
        const targetTop = e.clientY - 145 - 5;

        rightClickMenu.style.left = `${targetLeft}px`;
        rightClickMenu.style.top = `${targetTop}px`;
        rightClickMenu.style.display = 'block';
    });

    document.addEventListener('click', () => {
        const menu = document.getElementById('customDropdownMenu');
        if (menu) menu.style.display = 'none';
        rightClickMenu.style.display = 'none';
    });

    // 绑定右键菜单事件
    document.getElementById('rightOpt1').addEventListener('click', async (e) => {
        e.stopPropagation(); rightClickMenu.style.display = 'none';
        await handleCustomOption1();
    });
    document.getElementById('rightOpt2').addEventListener('click', async (e) => {
        e.stopPropagation(); rightClickMenu.style.display = 'none';
        await handleCustomOption2();
    });
    document.getElementById('rightOpt3').addEventListener('click', async (e) => {
        e.stopPropagation(); rightClickMenu.style.display = 'none';
        await handleCustomOption3();
    });
    document.getElementById('rightOpt4').addEventListener('click', async (e) => {
        e.stopPropagation(); rightClickMenu.style.display = 'none';
        await handleCustomOption4();
    });

    // 面板控制事件
    document.getElementById('startStopBtn2').addEventListener('click', function () {
        if (running) stop();
        else start();
    });

    document.getElementById('resetBtn2').addEventListener('click', resetAll);

    document.getElementById('customFuncBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = document.getElementById('customDropdownMenu');
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('dropdownOpt1').addEventListener('click', async () => { await handleCustomOption1(); });
    document.getElementById('dropdownOpt2').addEventListener('click', async () => { await handleCustomOption2(); });
    document.getElementById('dropdownOpt3').addEventListener('click', async () => { await handleCustomOption3(); });
    document.getElementById('dropdownOpt4').addEventListener('click', async () => { await handleCustomOption4(); });

    function updateUI () {
        const btn = document.getElementById('startStopBtn2');
        const statusEl = document.getElementById('statusIndicator');
        if (running) {
            btn.innerHTML = '⏹ 停止';
            btn.style.background = 'linear-gradient(135deg, #ff6b6b, #ee5a24)';
            statusEl.innerText = '运行中 ';
            statusEl.style.color = '#00ffc8';
            statusEl.style.background = 'rgba(0,255,200,0.15)';
        } else {
            btn.innerHTML = '▶ 启动';
            btn.style.background = 'linear-gradient(135deg, #00b4ff, #00ffc8)';
            statusEl.innerText = '离线';
            statusEl.style.color = '#aaa';
            statusEl.style.background = 'rgba(255,255,255,0.1)';
        }
        const floatBtn = document.getElementById('floatingActionBtn');
        if (running) {
            floatBtn.style.background = 'rgba(0,255,200,0.15)';
            floatBtn.style.color = '#00ffc8';
            floatBtn.style.borderColor = '#00ffc8';
            floatBtn.style.animation = 'pulse-glow 2.5s infinite';
        } else {
            floatBtn.style.background = 'rgba(255,255,255,0.05)';
            floatBtn.style.color = '#78909c';
            floatBtn.style.borderColor = '#546e7a';
            floatBtn.style.animation = 'none';
        }
    }

    loadStorage();
    updateCounts();
    addLog('✅ 已就绪 ');
})();