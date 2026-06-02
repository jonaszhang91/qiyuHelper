const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// 适配打包成 exe 后的路径获取（支持 process.pkg）
const currentDir = process.pkg ? path.dirname(process.execPath) : __dirname;

// ==================== 🛠️ 核心配置项 ====================
let APP_PATH = "";              
let SCRIPT_NAME = "autoRe.js";   
let DEBUG_PORT = 9222;          

// 🎯 【高能修改】：改回 GitHub 官方直链，并动态拼接随机参数，强制干掉所有 CDN 和系统缓存
const getLatestUrl = () => `https://raw.githubusercontent.com/jonaszhang91/qiyuHelper/main/autoRe.js?t=${Date.now()}`;

console.log("===================================================");
console.log("      网易七鱼 自动化控制面板 启动工具 (无缓存直注版)");
console.log("===================================================\n");

function cleanPath(rawPath) {
    if (!rawPath) return "";
    return rawPath.toString().trim().replace(/^["']|["']$/g, '').trim();
}

function selectExeAndWriteConfigSafe(configFilePath) {
    console.log('📬 正在打开系统文件选择窗口，请直接双击选中【网易七鱼.exe】启动程序...');
    const tempPathFile = path.join(currentDir, '_temp_raw_path.txt');
    const escapedTempPathFile = tempPathFile.replace(/\\/g, '\\\\');
    
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$FileBrowser = New-Object System.Windows.Forms.OpenFileDialog
$FileBrowser.Filter = "应用程序 (*.exe)|*.exe"
$FileBrowser.Title = "请直接选择【网易七鱼】的启动程序 (.exe)"
$FileBrowser.CheckFileExists = $true
$Show = $FileBrowser.ShowDialog()
if ($Show -eq "OK") {
    [System.IO.File]::WriteAllText("${escapedTempPathFile}", $FileBrowser.FileName, [System.Text.Encoding]::UTF8)
}
`.trim();

    const tempPsFile = path.join(currentDir, '_temp_selector.ps1');
    try {
        fs.writeFileSync(tempPsFile, '\ufeff' + psScript, 'utf8');
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempPsFile}"`, { stdio: 'ignore' });
        
        if (fs.existsSync(tempPathFile)) {
            const rawExePath = fs.readFileSync(tempPathFile, 'utf8').trim();
            if (rawExePath && fs.existsSync(rawExePath)) {
                const configObject = {
                    qiyu_path: rawExePath,
                    script_name: SCRIPT_NAME,
                    debug_port: DEBUG_PORT
                };
                fs.writeFileSync(configFilePath, JSON.stringify(configObject, null, 4), 'utf8');
            }
            fs.unlinkSync(tempPathFile);
        }
        if (fs.existsSync(tempPsFile)) fs.unlinkSync(tempPsFile);
    } catch (e) {
        if (fs.existsSync(tempPathFile)) try { fs.unlinkSync(tempPathFile); } catch(i){}
        if (fs.existsSync(tempPsFile)) try { fs.unlinkSync(tempPsFile); } catch(i){}
    }
}

// 采用官方 https 模块请求（国内直连 GitHub 如果报错，请确保开启了代理或者代理工具处于 TUN/全局 模式）
function downloadFromGithub(url) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const req = https.get(url, { 
            timeout: 6000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        }, (res) => {
            if (res.statusCode !== 200) return reject(new Error(`状态码: ${res.statusCode}`));
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', err => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
    });
}

function isQiyuRunning() {
    try {
        const stdout = execSync('tasklist /NH', { encoding: 'buffer' });
        const output = typeof TextDecoder !== 'undefined' ? new TextDecoder('gbk').decode(stdout) : stdout.toString('ansi');
        return output.includes('网易七鱼') || output.includes('qiyu') || output.includes('QiYu');
    } catch (e) {
        return false;
    }
}

function killQiyuProcesses() {
    try {
        execSync('taskkill /F /IM "网易七鱼.exe" /T 2>nul', { stdio: 'ignore' });
        execSync('taskkill /F /IM "qiyu-desktop.exe" /T 2>nul', { stdio: 'ignore' });
        execSync('taskkill /F /IM "qiyu.exe" /T 2>nul', { stdio: 'ignore' });
    } catch (e) {}
}

function checkPortOpen(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
            res.resume();
            resolve(true); 
        });
        req.on('error', () => resolve(false)); 
        req.setTimeout(600, () => { req.destroy(); resolve(false); });
    });
}

function launchQiyuRaw() {
    console.log(`🚀 [1/3] 正在开启远程调试并拉起网易七鱼主程序...`);
    const cmdStr = `start "" "${APP_PATH}" --remote-debugging-port=${DEBUG_PORT}`;
    exec(cmdStr, { windowsHide: false }, (err) => {
        if (err) console.error("❌ 拉起尝试失败:", err.message);
    });
}

async function startLauncher() {
    const configPath = path.join(currentDir, 'config.json');

    // ----------- 1. 路径自检 -----------
    if (!fs.existsSync(configPath)) {
        selectExeAndWriteConfigSafe(configPath);
        if (!fs.existsSync(configPath)) {
            console.error('🚨 [错误] 未选定合法的网易七鱼启动程序！');
            setTimeout(() => process.exit(1), 5000);
            return;
        }
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        APP_PATH = cleanPath(config.qiyu_path); 
        if (config.script_name) SCRIPT_NAME = config.script_name;
        if (config.debug_port) DEBUG_PORT = config.debug_port;
        console.log("⚙️  [成功] 已加载外部 config.json 配置文件");
    } catch (e) {
        console.error("❌ [错误] 配置文件损坏，正在重置...");
        try { fs.unlinkSync(configPath); } catch(i){}
        setTimeout(() => process.exit(1), 3000);
        return;
    }

    // ----------- 🌟 2. 实时无缓存云端同步 -----------
    let injectCode = "";
    const scriptPath = path.join(currentDir, SCRIPT_NAME);
    
    // 如果本地有，先读作备用
    if (fs.existsSync(scriptPath)) injectCode = fs.readFileSync(scriptPath, 'utf8');

    const realTimeUrl = getLatestUrl();
    console.log('🌐 正在绕过缓存，穿透下载 GitHub 最新实时源码...');
    try {
        const cloudCode = await downloadFromGithub(realTimeUrl);
        if (cloudCode && cloudCode.trim().length > 0) {
            // 只要云端能拿到，100% 强行刷入覆盖本地，不再做等同判断
            fs.writeFileSync(scriptPath, cloudCode, 'utf8');
            injectCode = cloudCode;
            console.log('📥 [成功] 已强行同步并覆盖本地核心代码为 GitHub 实时最新版！');
        }
    } catch (error) {
        console.warn('⚠️  [提示] 穿透联网下载受阻（已自动切为纯本地离线保护模式）');
        if (!injectCode) {
            console.error(`\n🚨 [严重错误] 首次运行或本地无脚本时，必须联网下载核心！`);
            setTimeout(() => process.exit(1), 8000);
            return;
        }
    }

    // ----------- 3. 智能多态判定 -----------
    console.log('\n🔍 正在进行系统进程自检...');
    const running = isQiyuRunning();

    if (running) {
        console.log('⚠️  [提示] 检测到网易七鱼正在运行，正在嗅探内核端口...');
        const isPortReady = await checkPortOpen(DEBUG_PORT);
        if (isPortReady) {
            console.log('⚡ [完美] 该进程已具备调试权限，跳过拉起，直接准备注入！');
        } else {
            console.log('♻️  [接管] 发现运行中的七鱼未开启调试通道。正在强制清空并重新接管启动...');
            killQiyuProcesses();
            await new Promise(resolve => setTimeout(resolve, 1500)); 
            launchQiyuRaw();
        }
    } else {
        launchQiyuRaw();
    }

    // ----------- 4. 通道建立与盲发无感注入 -----------
    let retryCount = 0;
    
    function tryInject() {
        http.get(`http://127.0.0.1:${DEBUG_PORT}/json`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const targets = JSON.parse(data);
                    const anyPage = targets.find(t => t.type === 'page' && (t.url.includes('qiyukf.com') || t.title.includes('会话'))) 
                                    || targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
                    
                    if (!anyPage || !anyPage.webSocketDebuggerUrl) {
                        throw new Error("未找到有效渲染窗口");
                    }

                    console.log("🔗 [2/3] 通道已连通，正在往七鱼内核传输代码...");
                    
                    const WebSocket = require('ws');
                    const ws = new WebSocket(anyPage.webSocketDebuggerUrl);

                    const doSend = () => {
                        ws.send(JSON.stringify({
                            id: 1,
                            method: 'Runtime.evaluate',
                            params: { expression: injectCode }
                        }));
                        
                        console.log("✅ [3/3] 自动化控制面板已成功无感嵌入七鱼窗口！");
                        
                        setTimeout(() => {
                            try { ws.close(); } catch(e){}
                            console.log("\n👋 任务全部完成，助手即将安全退出。");
                            setTimeout(() => { process.exit(0); }, 1000);
                        }, 800);
                    };

                    ws.on('open', doSend);
                    ws.onconnect = doSend;

                    ws.on('error', () => { 
                        try { ws.close(); } catch(e){}
                        reconnect(); 
                    });

                } catch (err) {
                    reconnect();
                }
            });
        }).on('error', () => {
            reconnect();
        });
    }

    function reconnect() {
        retryCount++;
        if (retryCount > 60) {
            console.error("\n❌ [错误] 智能拉起接管超时！请完全退出右下角托盘的七鱼后再试。");
            setTimeout(() => process.exit(1), 5000);
            return;
        }
        setTimeout(tryInject, 600); 
    }

    setTimeout(tryInject, 3000); 
}

startLauncher();