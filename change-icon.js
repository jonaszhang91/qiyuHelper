const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

// 替换为您的实际打包输出路径和 icon 路径
const exePath = path.join(__dirname, '七鱼助手.exe');
const iconPath = path.join(__dirname, 'logo.ico');

function changeIcon() {
    if (!fs.existsSync(exePath)) {
        console.error('找不到打包好的 exe 文件：', exePath);
        return;
    }
    if (!fs.existsSync(iconPath)) {
        console.error('找不到指定的 .ico 图标文件：', iconPath);
        return;
    }

    console.log('正在加载 exe 资源...');
    // 读取编译好的 exe 文件
    const bin = fs.readFileSync(exePath);
    const exe = ResEdit.NtExecutable.from(bin);
    const res = ResEdit.NtExecutableResource.from(exe);

    console.log('正在解析新图标文件...');
    const rawIcon = fs.readFileSync(iconPath);
    const iconFile = ResEdit.Data.IconFile.from(rawIcon);

    console.log('正在安全替换图标资源...');
    // 使用新版规范接口安全替换，同时映射内部的 icons 数组数据
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
        res.entries,
        1,       // 默认图标组 ID，Node.js 编译出的 exe 通常为 1
        1033,    // 语言 ID (1033 代表 English - United States)
        iconFile.icons.map((item) => item.data) // 关键修正：必须提取底层的二进制 mapping 数据
    );

    // 将修改后的资源写回 exe 结构体
    res.outputResource(exe);

    console.log('正在生成最终的可执行文件...');
    // 关键修正：新版直接调用 exe.generate()，不再需要 NtExecutableBuilder
    const newBin = exe.generate();
    
    // 写回物理文件
    fs.writeFileSync(exePath, Buffer.from(newBin));
    
    console.log('🎉 图标替换成功！');
}

changeIcon();
