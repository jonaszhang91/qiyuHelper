const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// 适配打包成 exe 后的路径获取（支持 process.pkg）
const currentDir = process.pkg ? path.dirname(process.execPath) : __dirname;

// ==================== 🛠️ 核心配置项 ====================
let APP_PATH = "";              
let SCRIPT_NAME = "autoRe.js";   // 对应你本地保存的文件名
let DEBUG_PORT = 9222;          

// 🎯 【已为你替换】：使用 jsDelivr CDN 全速加速你的 GitHub 真实脚本，防卡网死锁
const GITHUB_RAW_URL = 'https://cdn.jsdelivr.net/gh/jonaszhang91/qiyuHelper@main/autoRe.js';

console.log("===================================================");
console.log("      网易七鱼 自动化控制面板 启动工具 (正式生产版)");
console.log("===================================================\n");

function cleanPath(rawPath) {
    if (!rawPath) return "";
    return rawPath.toString().trim().replace(/^["']|["']$/g, '').trim();
}

function selectQiyuPathWindows() {
    console.log('📬 正在打开文件选择窗口，请选择七鱼软件的启动程序 (.exe)...');
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$FileBrowser = New-Object System.Windows.Forms.OpenFileDialog
$FileBrowser.Filter = "应用程序 (*.exe)|*.exe"
$FileBrowser.Title = "请选择七鱼软件的启动程序 (.exe)"
$Show = $FileBrowser.ShowDialog()
if ($Show -eq "OK") { Write-Output $FileBrowser.FileName }
`;
    const tempPsFile = path.join(currentDir, '_temp_select.ps1');
    try {
        fs.writeFileSync(tempPsFile, '\ufeff' + psScript, 'utf8');
        const stdoutBuffer = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempPsFile}"`, { encoding: 'buffer' });
        if (fs.existsSync(tempPsFile)) fs.unlinkSync(tempPsFile);
        let decodedString = typeof TextDecoder !== 'undefined' ? new TextDecoder('gbk').decode(stdoutBuffer) : stdoutBuffer.toString('ansi');
        return cleanPath(decodedString); 
    } catch (e) {
        if (fs.existsSync(tempPsFile)) fs.unlinkSync(tempPsFile);
        return null;
    }
}

function downloadFromGithub(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? require('https') : require('http');
        const req = protocol.get(url, { timeout: 4000 }, (res) => {
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

    // ----------- 1. 路径自适应读取 -----------
    if (!fs.existsSync(configPath)) {
        console.log('🆕 检测到首次使用，正在启动路径初始化向导...');
        const chosenPath = selectQiyuPathWindows();
        if (!chosenPath) {
            console.error('🚨 [错误] 未选择七鱼启动路径，程序无法继续！');
            setTimeout(() => process.exit(1), 5000);
            return;
        }
        const initialConfig = { qiyu_path: chosenPath, script_name: SCRIPT_NAME, debug_port: DEBUG_PORT };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 4), 'utf8');
        APP_PATH = chosenPath;
    } else {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            APP_PATH = cleanPath(config.qiyu_path); 
            if (config.script_name) SCRIPT_NAME = config.script_name;
            if (config.debug_port) DEBUG_PORT = config.debug_port;
            console.log("⚙️  [成功] 已加载外部 config.json 配置文件");
        } catch (e) {
            console.error("❌ [警告] 读取 config.json 格式错误");
        }
    }

    if (!APP_PATH) {
        console.error("🚨 [错误] 七鱼启动路径为空！请删除 config.json 后重新运行！");
        setTimeout(() => process.exit(1), 5000);
        return;
    }

    // ----------- 2. 云端高速同步 -----------
    let injectCode = "";
    const scriptPath = path.join(currentDir, SCRIPT_NAME);
    const hasLocalScript = fs.existsSync(scriptPath);
    if (hasLocalScript) injectCode = fs.readFileSync(scriptPath, 'utf8');

    console.log('🌐 正在检测云端脚本是否有更新...');
    try {
        const cloudCode = await downloadFromGithub(GITHUB_RAW_URL);
        if (cloudCode !== injectCode) {
            console.log(hasLocalScript ? '🔄 [更新] 检测到云端代码有变动，正在同步到本地...' : '📥 [下载] 首次下载 autoRe.js 成功！');
            fs.writeFileSync(scriptPath, cloudCode, 'utf8');
            injectCode = cloudCode;
        } else {
            console.log('等同 [保持最新] 本地核心代码与云端一致，无需下载。');
        }
    } catch (error) {
        console.warn('⚠️  [提示] 联网失败或超时（已自动转为纯本地离线保护模式）');
        if (!injectCode) {
            console.error(`\n🚨 [严重错误] 首次运行必须联网下载脚本！`);
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
            await new Promise(resolve => setTimeout(resolve, 1200)); 
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
            console.error("\n❌ [错误] 智能拉起接管超时！请检查是否有安全软件拦截。");
            setTimeout(() => process.exit(1), 5000);
            return;
        }
        setTimeout(tryInject, 600); 
    }

    setTimeout(tryInject, 3000); 
}

startLauncher();
//pkg . --output 七鱼助手.exe