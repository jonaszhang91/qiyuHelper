const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

// 替换为你的 pkg 打包输出路径和 icon 路径
const exePath = path.join(__dirname, '七鱼助手.exe');
const iconPath = path.join(__dirname, 'logo.ico');

function changeIcon() {
    if (!fs.existsSync(exePath)) {
        console.error('找不到打包好的 exe 文件：', exePath);
        return;
    }

    // 读取编译好的 exe 文件
    let exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
    // 读取 ico 图标文件
    let rawIcon = fs.readFileSync(iconPath);

    // 加载图标数据
    let iconFile = ResEdit.IconFile.from(rawIcon);
    let groupEntries = ResEdit.Resource.IconGroupEntry.createFrom(iconFile.icons, 0);

    // 更新 exe 中的图标资源
    ResEdit.Resource.updateIconGroup(exe.resources, 1, groupEntries, iconFile.icons);

    // 将修改后的资源写回 exe 文件
    let builder = new ResEdit.NtExecutableBuilder(exe);
    fs.writeFileSync(exePath, builder.generate());
    
    console.log('图标替换成功！');
}

changeIcon();
