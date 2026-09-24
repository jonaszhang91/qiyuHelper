// ==UserScript==
// @name         autoResForSevenFish
// @namespace    http://tampermonkey.net/
// @version      2026-09-23
// @description  七鱼自动回复 + 悬浮球右键服务小记菜单（动态等待 + 双版本 DOM 兼容版）
// @author       jonas
// @match        https://mjhlwkjnjyxgs.qiyukf.com/chat/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=qiyukf.com
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ========== 配置 ==========
    const CONFIG = {
        DEEPSEEK_API_KEY: 'sk-637d4c94e82845558f336105a10a42fd', // 填入你的 DeepSeek API Key
        PROXY_URL: 'https://bold-wind-9b8a.jonaszhang91.workers.dev/', // 你的代理地址
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

    // 动态等待元素出现
    function waitForElement(selector, timeout = 5000) {
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
            }, 100);
        });
    }

    // 动态等待条件成立（用于等待多级菜单 DOM 更新）
    function waitForCondition(predicate, timeout = 5000) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = setInterval(() => {
                const res = predicate();
                if (res) {
                    clearInterval(check);
                    resolve(res);
                } else if (Date.now() - start > timeout) {
                    clearInterval(check);
                    resolve(null);
                }
            }, 100);
        });
    }

    function getSessionId(el) {
        let id = el.getAttribute('data-id');
        if (id && id.trim()) return 'id_' + id.trim();
        const title = el.querySelector('.truncate')?.innerText?.trim();
        return title ? 'title_' + title : null;
    }

    function getAllSessions() {
        return Array.from(document.getElementsByClassName(CONFIG.PARENT_CLASS));
    }

    // ---------- 数据持久化 ----------
    function saveReplied() {
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify([...repliedIds]));
    }
    function saveKnown() {
        localStorage.setItem(CONFIG.KNOWN_STORAGE_KEY, JSON.stringify([...knownSessions]));
    }
    function loadStorage() {
        try {
            const rep = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (rep) repliedIds = new Set(JSON.parse(rep));
            const known = localStorage.getItem(CONFIG.KNOWN_STORAGE_KEY);
            if (known) knownSessions = new Set(JSON.parse(known));
        } catch (e) { }
    }

    // ---------- AI 分析与聊天记录抓取 ----------

    function extractVisibleChatLogs() {
        const logs = [];
        const msgNodes = document.querySelectorAll(
            '.m-ct-message, .m-message-item, .u-msg, [data-test="message-item"], .msg'
        );

        msgNodes.forEach(node => {
            const className = node.className || '';
            if (
                className.includes('msg-sys') ||
                className.includes('msg-splitLine') ||
                className.includes('msg-cnotify') ||
                className.includes('msg-remark') ||
                className.includes('msg-transkefu') ||
                className.includes('msg-sessionId') ||
                className.includes('msg-receiptkefuinfo') ||
                node.querySelector('.sys-text, .m-sys-text')
            ) {
                return;
            }

            let role = '未知';
            if (
                className.includes('msg-left') ||
                node.querySelector('.msg-left, .u-msg-left') ||
                node.classList.contains('item-left')
            ) {
                role = '客户';
            } else if (
                className.includes('msg-right') ||
                node.querySelector('.msg-right, .u-msg-right') ||
                node.classList.contains('item-right')
            ) {
                role = '客服';
            }

            const timeEl = node.querySelector('[data-test="time"], .time, .msg-time, .u-msg-time');
            const time = timeEl ? timeEl.innerText.trim() : '';

            const textContainer = node.querySelector(
                '[data-test="content"], .msg-text-content, .m-msg-text, .msg-text, .content, .u-msg-text, .text'
            ) || node;

            let cleanContent = textContainer.innerText || textContainer.textContent || '';
            cleanContent = cleanContent.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();

            if (time && cleanContent.startsWith(time)) {
                cleanContent = cleanContent.replace(time, '').trim();
            }

            if (cleanContent && cleanContent.length > 0) {
                const isDuplicate = logs.some(l => l.role === role && l.content === cleanContent && l.time === time);
                if (!isDuplicate) {
                    logs.push({ time, role, content: cleanContent });
                }
            }
        });

        return logs;
    }

    async function callAIForServiceLog() {
        const logs = extractVisibleChatLogs();
        if (logs.length === 0) {
            addLog('⚠️ 未能读取到当前界面聊天记录');
            return null;
        }

        const formattedTranscript = logs.map(item => `[${item.time || '未知'}] ${item.role}: ${item.content}`).join('\n');

        const systemPrompt = `你是一名专业的点餐系统客服分类助手。请根据聊天内容，从以下预定义的分类列表中选出最匹配的一项，并严格返回一个 JSON 对象，不要包含 markdown 或任何多余文本。
会话中 技术支持是我们处理
【分类与编号对应列表】：
- POS设置: "3,0"
- Paypad/Tripos: "3,1"
- Kiosk/Emenu: "3,2"
- Online Order: "3,3"
- 报表/手机报表: "3,4"
- 刷卡机: "3,5"
- 打印机: "3,6"
- Caller ID: "3,7"
- 磅秤: "3,8"
- 其他硬件: "3,9"
- Ubuntu/Windows: "3,10"
- 软件升级: "3,11"
- 网络连接: "3,12"
- 需求: "3,13"
- Bug: "3,14"
- 批量问题: "3,15"
- RMA: "3,16"
- license相关: "3,17"
- Batch相关: "3,18"
- 预约时间: "3,19"
- 其他: "6,4"
修改内容不要算需求算设置，只有会话中明确提到反馈研发的才算需求和 bug 不然都选择对应的问题
【返回 JSON 格式要求】：
{
  "type": "分类名称",
  "code": "编号",
  "sub": "总结一下 10 个字以内，主要以技术支持最后处理一个问题的内容为主，只总结最近的一段对话里面的技术问题"
}`;

        try {
            const response = await fetch(CONFIG.PROXY_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: `以下是聊天记录：\n\n${formattedTranscript}` }
                    ],
                    response_format: { type: 'json_object' },
                    temperature: 0.1
                })
            });

            if (response.ok) {
                const resData = await response.json();
                const jsonContent = JSON.parse(resData.choices[0].message.content);
                return jsonContent;
            } else {
                addLog(`❌ AI 请求失败: ${response.status}`);
            }
        } catch (err) {
            console.error(err);
            addLog('❌ AI 请求异常');
        }
        return null;
    }

    function setInputValue(element, value) {
        if (!element) return;
        const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
        const prototype = Object.getPrototypeOf(element);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
            prototypeValueSetter.call(element, value);
        } else if (valueSetter) {
            valueSetter.call(element, value);
        } else {
            element.value = value;
        }

        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    async function handleAIServiceLogTrigger() {
        addLog('🤖 AI 正在分析对话...');
        const result = await callAIForServiceLog();

        if (result && result.code) {
            const [n, m] = result.code.split(',').map(Number);
            addLog(`⚙️ AI 匹配类型: [${result.type}] -> clickTarge(${n}, ${m})`);

            const success = await clickTarge(n, m);
            if (!success) return;

            // 动态等待 #description 文本框出现，兼容新旧 DOM 写入
            const textarea = await waitForElement('textarea#description', 5000);
            if (textarea) {
                const textToFill = result.sub || result.type || '';
                textarea.focus();
                setInputValue(textarea, textToFill);
                addLog(`📝 已填入备注 (sub): "${textToFill}"`);
            } else {
                addLog('⚠️ 未能找到 #description 文本框（等待超时）');
            }
        } else {
            addLog('⚠️ AI 未能提取到正确的分类 code');
        }
    }

    // ---------- 核心逻辑 ----------
    function getNewMarkedSessions() {
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

    function rebuildKnownSet() {
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

    function addToKnown(el) {
        const uid = getSessionId(el);
        if (!uid) return;
        if (!knownSessions.has(uid)) {
            knownSessions.add(uid);
            saveKnown();
        }
    }

    function markReplied(el) {
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

    function isReplied(el) {
        const uid = getSessionId(el);
        if (!uid) return false;
        if (el.getAttribute('data-ysf-replied') === 'true') return true;
        if (repliedIds.has(uid)) return true;
        if (cooldownIds.has(uid)) return true;
        return false;
    }

    function shouldReply(el) {
        const uid = getSessionId(el);
        if (!uid) return false;
        if (isReplied(el)) return false;
        return !knownSessions.has(uid);
    }

    async function processSession(el) {
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

    async function performScan() {
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

    async function start() {
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

    function stop() {
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

    function resetAll() {
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
    //  自动点击服务小记（新旧版 DOM 兼容 + 降级兜底算法）
    // =========================================================

    // 1. 寻找并确保“服务小记”面板处于可见状态
// 1. 精准定位并确保“服务小记”Tab 处于激活状态
let clickLogBtn = async () => {
    // 优先通过属性精准查找“服务小记” Tab 按钮
    const tabSelectors = [
        '.ant-tabs-tab[data-node-key="serviceNote"]',
        '[id$="-tab-serviceNote"]',
        '.ant-tabs-tab-btn[aria-controls$="-panel-serviceNote"]'
    ];

    let targetTab = null;
    for (const sel of tabSelectors) {
        targetTab = document.querySelector(sel);
        if (targetTab) break;
    }

    if (targetTab) {
        // 判断当前 Tab 是否已被激活（包含 active 类名，或者内部按钮 aria-selected === "true"）
        const isAlreadyActive = targetTab.classList.contains('ant-tabs-tab-active') ||
                                targetTab.getAttribute('aria-selected') === 'true' ||
                                targetTab.querySelector('[aria-selected="true"]');

        if (!isAlreadyActive) {
            // 未激活时触发点击，支持元素本身或内部 .ant-tabs-tab-btn
            const clickTarget = targetTab.querySelector('.ant-tabs-tab-btn') || targetTab;
            clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            clickTarget.click();
            addLog('✅ 已切换至【服务小记】Tab');
            await delay(300); // 等待 Tab 切换动画及面板加载
        } else {
            addLog('ℹ️ 【服务小记】Tab 已处于激活状态');
        }
        return true;
    }

    // 备用兼容逻辑：检查右侧侧边栏/卡片中是否已有直接显示的面板
    const newServiceNotePanel = document.querySelector('.m-websession-userInfo-serviceNote, .card-content');
    if (newServiceNotePanel) {
        addLog('✅ 检测到侧边栏【服务小记】面板');
        return true;
    }

    addLog('⚠️ 未能找到“服务小记” Tab 入口');
    return false;
};

    // 2. 点击展开“咨询分类”下拉框
    let clickLogTextBtn = async () => {
        // [新版 AntDesign DOM] 匹配卡片模式下的【咨询分类】下拉选择框
        const newTabSelector = ".m-websession-userInfo-serviceNote .Tabselect .ant-select-selector, div[id^='categoryTabSelect_'] .ant-select-selector, .Tabselect .ant-select-selector";
        const newSelect = document.querySelector(newTabSelector);
        if (newSelect) {
            newSelect.click();
            addLog('✅ 点击【咨询分类】下拉框');
            return true;
        }

        // [旧版 DOM] 匹配老版的分类标签按钮
        const oldTextBtnSelector = ".Tabselect > div > div > div > div > div > span > span";
        const oldLogTextBtn = await waitForElement(oldTextBtnSelector, 2000);
        if (oldLogTextBtn) {
            oldLogTextBtn.click();
            return true;
        }

        addLog('⚠️ 未能找到服务小记分类选择入口');
        return false;
    };

    // 组合入口触发
    let autoClick = async () => {
        const step1 = await clickLogBtn();
        if (!step1) return false;
        await delay(200);
        const step2 = await clickLogTextBtn();
        return step2;
    };

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

    // 3. 兼容双版本 DOM + 降级容错点击机制
   let clickTarge = async (n, m) => {
        const ready = await autoClick();
        if (!ready) return false;

        await delay(350); // 留出下拉菜单展开过渡动画

        const targeClass = 'Tabselect-muPopupContent-category-button';

        // === 一级分类搜寻 ===
        let firstEls = await waitForCondition(() => {
            let els = document.querySelectorAll(`.${targeClass}>span`);
            if (els && els.length > n) return els;

            // AntDesign 列表节点
            const antOptions = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item, .ant-cascader-menu:first-child .ant-cascader-menu-item');
            if (antOptions && antOptions.length > n) return antOptions;

            return null;
        }, 2000);

        if (!firstEls || !firstEls[n]) {
            addLog(`❌ 未能找到第 ${n} 个一级分类`);
            return false;
        }

        // 确保元素在视口内并触发点击
        firstEls[n].scrollIntoView?.({ block: 'nearest' });
        firstEls[n].click();
        await delay(400); // 增加二层级联列表渲染的等待时间

        // === 二级分类搜寻（重点强化大索引项如 11 的获取） ===
        let secondEls = await waitForCondition(() => {
            // 方式 A: 级联菜单第二列 (AntDesign Cascader Menu 2)
            const secondCascader = document.querySelectorAll('.ant-cascader-menu:nth-child(2) .ant-cascader-menu-item');
            if (secondCascader && secondCascader.length > m) return secondCascader;

            // 方式 B: 普通下拉框的展开项
            const activeDropdown = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item');
            if (activeDropdown && activeDropdown.length > m) return activeDropdown;

            // 方式 C: 传统 Class
            let els = document.querySelectorAll(`.${targeClass}>span`);
            if (els && els.length > m) return els;

            return null;
        }, 2500);

        // 降级搜寻：如果在级联第二列找不齐 m 项，抓取当前开启菜单内的所有可交互项
        if (!secondEls) {
            addLog(`⚠️ 启动二级选项全域搜寻...`);
            const menus = document.querySelectorAll('.ant-cascader-menu, .ant-select-dropdown:not(.ant-select-dropdown-hidden)');
            const targetMenu = menus[menus.length - 1]; // 取最新的弹层
            if (targetMenu) {
                const items = targetMenu.querySelectorAll('.ant-cascader-menu-item, .ant-select-item, li, div[role="option"]');
                if (items.length > m) secondEls = items;
            }
        }

        if (secondEls && secondEls[m]) {
            const targetEl = secondEls[m];

            // 核心修复：滚动到可视区域，确保虚拟列表/长菜单完成渲染与事件绑定
            targetEl.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
            await delay(100);

            // 深度点击：同时派发原生 MouseEvent，防止框架绑定的 click 事件失灵
            targetEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            targetEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            targetEl.click();

            addLog(`✅ 成功点击第 ${m} 项二级分类`);
        } else {
            addLog(`❌ 二级分类 ${m} 点击失败（未匹配到 DOM 节点）`);
            return false;
        }

        await delay(200);
        clickCoordinate(50, 50); // 关闭弹层
        return true;
    };

    async function handleCustomOption1() { addLog('⚙️ 触发：pos 设置'); await clickTarge(3, 0); }
    async function handleCustomOption2() { addLog('⚙️ 触发：刷卡机问题'); await clickTarge(3, 5); }
    async function handleCustomOption3() { addLog('⚙️ 触发：打印机问题'); await clickTarge(3, 6); }
    async function handleCustomOption4() { addLog('⚙️ 触发：其他'); await clickTarge(6, 4); }

    // ---------- UI 辅助 ----------
    function updateCounts() {
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
    function addLog(msg) {
        lastLog = msg;
        const logEl = document.getElementById('logLine');
        if (logEl) logEl.innerText = msg;
        console.log(msg);
    }

    // ========== 构建控制面板与悬浮UI ==========
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
    display:none; position:fixed; width:150px; background:rgba(15,25,35,0.95); backdrop-filter:blur(10px); border:1px solid rgba(0,255,200,0.5); border-radius:12px; box-shadow:0 10px 25px rgba(0,0,0,0.5); overflow:hidden; z-index:10001; pointer-events:auto;
    `;
    rightClickMenu.innerHTML = `
        <div style="padding:6px 12px; font-size:10px; color:#78909c; background:rgba(0,255,200,0.05); border-bottom:1px solid rgba(0,255,200,0.2); font-weight:bold;">🚀 快捷记录</div>
        <div id="rightOptAI" class="ysf-right-menu-item" style="padding:8px 12px; color:#00ffc8; font-size:12px; cursor:pointer; text-align:left; border-bottom:1px solid rgba(255,255,255,0.05); font-weight:bold;">🤖 AI 智能分析分类</div>
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
                <div id="dropdownOptAI" class="ysf-dropdown-item" style="padding:8px 12px; color:#00ffc8; font-size:12px; cursor:pointer; text-align:left; border-bottom:1px solid rgba(255,255,255,0.05); font-weight:bold;">🤖 AI 智能分析</div>
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

    floatingBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const targetLeft = e.clientX - 150 - 5;
        const targetTop = e.clientY - 165 - 5;

        rightClickMenu.style.left = `${targetLeft}px`;
        rightClickMenu.style.top = `${targetTop}px`;
        rightClickMenu.style.display = 'block';
    });

    document.addEventListener('click', () => {
        const menu = document.getElementById('customDropdownMenu');
        if (menu) menu.style.display = 'none';
        rightClickMenu.style.display = 'none';
    });

    // 右键快捷菜单逻辑
    document.getElementById('rightOptAI').addEventListener('click', async (e) => {
        e.stopPropagation(); rightClickMenu.style.display = 'none';
        await handleAIServiceLogTrigger();
    });
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

    // 控制面板逻辑
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

    document.getElementById('dropdownOptAI').addEventListener('click', async () => { await handleAIServiceLogTrigger(); });
    document.getElementById('dropdownOpt1').addEventListener('click', async () => { await handleCustomOption1(); });
    document.getElementById('dropdownOpt2').addEventListener('click', async () => { await handleCustomOption2(); });
    document.getElementById('dropdownOpt3').addEventListener('click', async () => { await handleCustomOption3(); });
    document.getElementById('dropdownOpt4').addEventListener('click', async () => { await handleCustomOption4(); });

    function updateUI() {
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


//vpn 分装
(function () {
    if (window.__MID_VPN_BADGE_INITED__) return;
    window.__MID_VPN_BADGE_INITED__ = true;

    // 🔗 你的本地 API 服务基地址
    const API_BASE = 'https://tender-austin-noted-cowboy.trycloudflare.com/api/vpn';
    const PROCESSED_ATTR = 'data-vpn-processed';

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // 通用剪贴板复制工具
    function copyText(text) {
        if (typeof GM_setClipboard !== 'undefined') {
            GM_setClipboard(text);
        } else if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
    }

    // 网络请求封装
    function httpRequest(options) {
        return new Promise((resolve) => {
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    ...options,
                    onload: (res) => resolve({ status: res.status, text: res.responseText }),
                    onerror: () => resolve({ status: 500, text: '' })
                });
            } else {
                fetch(options.url, {
                    method: options.method || 'GET',
                    headers: options.headers,
                    body: options.data
                })
                .then(async res => ({ status: res.status, text: await res.text() }))
                .then(res => resolve(res))
                .catch(() => resolve({ status: 500, text: '' }));
            }
        });
    }

    // 全局单例悬浮框管理
    let activeDetailCard = null;

    function hideActiveCard() {
        if (activeDetailCard) {
            activeDetailCard.remove();
            activeDetailCard = null;
        }
    }

    document.addEventListener('click', () => hideActiveCard());
    window.addEventListener('scroll', () => hideActiveCard(), true);

    function buildInlineVpnBadge(mid) {
        const wrapper = document.createElement('span');
        wrapper.className = 'inline-vpn-wrapper';
        wrapper.style.cssText = 'display: inline-flex; align-items: center; margin-right: 8px; vertical-align: middle; font-size: 12px; font-weight: normal;';

        const badge = document.createElement('span');
        badge.style.cssText = 'padding: 2px 8px; border-radius: 12px; background: #f5f5f5; border: 1px solid #d9d9d9; color: #666; font-size: 12px; transition: all 0.2s; user-select: none;';
        badge.innerText = '⏳ 查询中...';

        wrapper.appendChild(badge);

        // 异步获取并处理状态
        (async () => {
            let retryCount = 0;
            const maxRetries = 3;
            let targetDevice = null;

            while (retryCount < maxRetries) {
                if (retryCount > 0) {
                    badge.innerText = `🔄 同步中 (${retryCount + 1}/${maxRetries})...`;
                    await sleep(3000);
                }

                // 调用你的本地后端接口
                const res = await httpRequest({
                    method: "GET",
                    url: `${API_BASE}/auto-enable?merchantId=${mid}`,
                    headers: { "Accept": "application/json, text/plain, */*" }
                });

                if (res.status !== 200) {
                    badge.style.background = '#fff2f0';
                    badge.style.borderColor = '#ffccc7';
                    badge.style.color = '#ff4d4f';
                    badge.innerText = '❌ 服务异常';
                    return;
                }

                try {
                    const resultJson = JSON.parse(res.text);
                    const list = resultJson.data || [];

                    if (!list.length) {
                        badge.style.background = '#fff2f0';
                        badge.style.borderColor = '#ffccc7';
                        badge.style.color = '#ff4d4f';
                        badge.innerText = '❌ 无数据';
                        return;
                    }

                    // 1. 检查是否有 Windows 系统设备
                    const winDevice = list.find(i => i.system && i.system.toLowerCase().includes('windows'));
                    if (winDevice) {
                        badge.style.background = '#fff7e6';
                        badge.style.borderColor = '#ffd591';
                        badge.style.color = '#fa8c16';
                        badge.innerText = '橙色 [WIN系统]';
                        return;
                    }

                    // 2. 查找 Server 设备
                    let serverDevice = list.find(i => i.posMode === 'server');
                    if (!serverDevice) {
                        badge.style.background = '#f5f5f5';
                        badge.innerText = '⚪ 无Server';
                        return;
                    }

                    // 3. 检查是否离线
                    if (!serverDevice.ifOnline) {
                        badge.style.background = '#f5f5f5';
                        badge.style.color = '#8c8c8c';
                        badge.innerText = `⚪ [Server] 离线 (${serverDevice.vpnIp || '无IP'})`;
                        return;
                    }

                    // 4. 如果在线且已经开启 (vpnEnable === true)
                    if (serverDevice.vpnEnable) {
                        targetDevice = serverDevice;
                        break;
                    }

                    // 如果在线但未开启，则继续下一次重试轮询
                } catch (e) {
                    // 解析错误跳过继续重试
                }

                retryCount++;
            }

            // 如果重试 3 次后依然没有成功开启
            if (!targetDevice) {
                badge.style.background = '#fff2f0';
                badge.style.borderColor = '#ffccc7';
                badge.style.color = '#ff4d4f';
                badge.innerText = '🔴 [Server] 开启失败';
                return;
            }

            // 5. 成功在线状态渲染
            badge.style.background = '#f6ffed';
            badge.style.borderColor = '#b7eb8f';
            badge.style.color = '#52c41a';
            badge.style.cursor = 'pointer';
            badge.innerHTML = '🟢 [Server] 在线 <span style="font-size: 10px;">▲</span>';

            const version = targetDevice.posVersion || '无';
            const vpnIp = targetDevice.vpnIp || '';

            badge.onclick = (e) => {
                e.stopPropagation();

                if (activeDetailCard && activeDetailCard.__ownerBadge === badge) {
                    hideActiveCard();
                    return;
                }

                hideActiveCard();

                const card = document.createElement('div');
                card.__ownerBadge = badge;
                card.style.cssText = `
                    position: fixed;
                    z-index: 999999;
                    padding: 8px 12px;
                    background: #ffffff;
                    border: 1px solid #b7eb8f;
                    border-radius: 6px;
                    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
                    font-size: 12px;
                    color: #333;
                    line-height: 1.6;
                    white-space: nowrap;
                    pointer-events: auto;
                `;

                card.innerHTML = `
                    <div style="color: #389e0d;"><b>版本:</b> ${version}</div>
                    <div style="display: flex; align-items: center; margin-top: 2px; color: #389e0d;">
                        <b>IP:</b> <span style="margin: 0 4px; font-weight: bold;">${vpnIp || '无'}</span>
                        ${vpnIp ? `
                            <button class="btn-copy-ip" style="margin-left: 6px; padding: 1px 6px; font-size: 11px; background: #e6f4ff; color: #0958d9; border: 1px solid #91caff; border-radius: 3px; cursor: pointer;">复制</button>
                            <button class="btn-jump-ip" style="margin-left: 4px; padding: 1px 6px; font-size: 11px; background: #f6ffed; color: #389e0d; border: 1px solid #b7eb8f; border-radius: 3px; cursor: pointer;">跳转</button>
                        ` : ''}
                    </div>
                `;

                card.onclick = (event) => event.stopPropagation();

                if (vpnIp) {
                    const btnCopy = card.querySelector('.btn-copy-ip');
                    const btnJump = card.querySelector('.btn-jump-ip');

                    if (btnCopy) {
                        btnCopy.onclick = (event) => {
                            event.stopPropagation();
                            copyText(vpnIp);
                            btnCopy.innerText = '已复制';
                            setTimeout(() => { btnCopy.innerText = '复制'; }, 1200);
                        };
                    }

                    if (btnJump) {
                        btnJump.onclick = (event) => {
                            event.stopPropagation();
                            const url = vpnIp.startsWith('http') ? `${vpnIp}:22080` : `http://${vpnIp}:22080`;
                            window.open(url, '_blank');
                        };
                    }
                }

                document.body.appendChild(card);
                activeDetailCard = card;

                const rect = badge.getBoundingClientRect();
                const cardRect = card.getBoundingClientRect();

                const top = rect.top - cardRect.height - 6;
                const left = rect.left;

                card.style.top = `${Math.max(10, top)}px`;
                card.style.left = `${left}px`;
            };
        })();

        return wrapper;
    }

    window.scanAndAppendMidVpnBadges = function () {
        const xpath = "//text()[contains(., 'M000')]";
        const result = document.evaluate(xpath, document.body, null, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, null);

        for (let i = 0; i < result.snapshotLength; i++) {
            const textNode = result.snapshotItem(i);
            const parent = textNode.parentElement;

            if (!parent || parent.closest('.inline-vpn-wrapper') || parent.hasAttribute(PROCESSED_ATTR)) {
                continue;
            }

            const text = textNode.nodeValue;
            const match = text.match(/M000[A-Za-z0-9]+/);

            if (match) {
                const mid = match[0];
                parent.setAttribute(PROCESSED_ATTR, 'true');

                const vpnBadge = buildInlineVpnBadge(mid);
                parent.parentNode.insertBefore(vpnBadge, parent);
            }
        }
    };

    function initMidVpnModule() {
        const observer = new MutationObserver(() => {
            window.scanAndAppendMidVpnBadges();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        window.scanAndAppendMidVpnBadges();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMidVpnModule);
    } else {
        initMidVpnModule();
    }
})();
