/**
 * WebUI 单文件页面（Alpine.js + 定制设计系统，零构建）
 *
 * 设计方向：Industrial Studio Console（工业工作室控制台）
 * - 三模态 = 三条通道（channel strip），各有信号灯/状态
 * - 系统无衬线字族（标题/正文）+ 系统等宽字族（数据/标签/代码），避免从第三方字体 CDN 加载资源
 * - 深色暖调底 + 单一信号色 acid lime（就绪/运行态）
 *
 * 三大区块：
 * 1. 通道配置（CHANNELS）：image / video / audio 三模态信号链
 * 2. 试用台（PLAYGROUND）：选模态 + prompt → 生成 → 内联预览
 * 3. 接入向导（PATCH）：选 agent → 一键复制 mcpServers JSON
 *
 * 所有交互通过 fetch 调用 /api/* REST 端点。
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 运行时从 package.json 读取版本号，与发版来源保持一致（唯一权威）。 */
function readPackageVersion(): string {
  try {
    // dist/webui/index-html.js → 上两级到项目根
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const PRISM_VERSION = readPackageVersion()

export const WEBUI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Prismstudio · Multi-Modal Generation Console</title>
<script defer src="/assets/alpine.min.js"></script>
<script>
// 防闪烁：Alpine 加载前先应用持久化的主题与语言（中文为默认）
(function(){
  try {
    var theme = localStorage.getItem('prism-theme') || 'dark';
    var lang = localStorage.getItem('prism-lang') || 'zh';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
  } catch(e) { document.documentElement.setAttribute('data-theme','dark'); }
})();
</script>
<style>
/* ===== 设计令牌：Industrial Studio Console（双主题） ===== */
/* dark：深色暖调控制台（默认） */
[data-theme="dark"]{
  --surface-0:#0c0d0a;            /* 最底（页面背景） */
  --surface-1:rgba(20,22,17,0);   /* 透明叠加占位 */
  --surface-2:#1a1c16;            /* 卡片底 */
  --surface-3:#232520;            /* 抬升面板 */
  --surface-4:#2d3028;            /* 输入/高亮面 */

  --text-primary:#ecebe1;         /* 主文字，暖白 */
  --text-secondary:#b8b8a8;       /* 次文字 */
  --text-muted:#7a7b6c;           /* 标签/弱化 */
  --text-dim:#494a41;             /* 最弱 */

  --signal:#c4f542;               /* acid lime · 主强调 */
  --signal-dim:#7a9426;
  --signal-glow:rgba(196,245,66,.35);
  --signal-contrast:#0c0d0a;      /* 信号色背景上的文字色 */

  --warn:#f5a142;
  --error:#f55d5d;
  --info:#5fb8f5;

  --line:#2f3128;
  --line-bright:#42453a;

  /* 代码块专属（深色更暗） */
  --code-bg:#0a0b08;
  --code-text:#c8c8b8;
  --grid-opacity:.25;
  --noise-opacity:.04;
  --shadow-md:0 8px 24px -12px rgba(0,0,0,.6), 0 1px 0 var(--line) inset;
  --shadow-lg:0 20px 50px -20px rgba(0,0,0,.8), 0 1px 0 var(--line-bright) inset;
}

/* light：暖白纸质工业风（克制仪器感，非通用亮色） */
[data-theme="light"]{
  --surface-0:#f3f1ea;            /* 暖白纸张底 */
  --surface-1:rgba(255,255,255,0);
  --surface-2:#ffffff;            /* 卡片：纯白抬升 */
  --surface-3:#faf8f1;            /* 面板：略带暖意 */
  --surface-4:#efede4;            /* 输入/高亮面 */

  --text-primary:#1c1d18;         /* 主文字：深墨暖黑 */
  --text-secondary:#54544a;       /* 次文字 */
  --text-muted:#86867a;           /* 标签 */
  --text-dim:#b0b0a4;             /* 最弱 */

  /* 信号色在亮底上加深，保证对比度（WCAG） */
  --signal:#5d7a14;               /* 深橄榄绿 acid */
  --signal-dim:#8aa82e;
  --signal-glow:rgba(93,122,20,.18);
  --signal-contrast:#ffffff;

  --warn:#b5610a;
  --error:#c63838;
  --info:#2a7ab8;

  --line:#e2dfd2;
  --line-bright:#cfccbe;

  --code-bg:#fbfaf3;
  --code-text:#3a3a30;
  --grid-opacity:.5;
  --noise-opacity:.025;
  --shadow-md:0 8px 24px -14px rgba(60,55,40,.18), 0 1px 0 var(--line) inset;
  --shadow-lg:0 20px 50px -22px rgba(60,55,40,.22), 0 1px 0 var(--line-bright) inset;
}

:root{
  /* 间距/字号/圆角等与主题无关的尺度（共享） */
  --space-xs:.375rem; --space-sm:.625rem; --space-md:1rem;
  --space-lg:1.75rem; --space-xl:3rem; --space-2xl:5rem;

  --fs-mono-xs:.6875rem; --fs-mono-sm:.75rem; --fs-mono-md:.8125rem;
  --fs-display-xl:clamp(2rem,5vw,3.25rem);
  --fs-display-lg:clamp(1.5rem,3vw,2.125rem);
  --fs-body:.9375rem;

  --radius:2px;
  --radius-lg:3px;

  --font-sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
}

*{box-sizing:border-box;margin:0;padding:0}

html,body{
  background:var(--surface-0);
  color:var(--text-primary);
  font-family:var(--font-sans);
  font-size:var(--fs-body);
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
  min-height:100vh;
}

/* 背景纹理：极淡的网格 + 噪点，工业控制台底子 */
body::before{
  content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;
  background-image:
    linear-gradient(var(--line) 1px,transparent 1px),
    linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:64px 64px;
  opacity:var(--grid-opacity);
  mask-image:radial-gradient(ellipse at top,#000 0%,transparent 75%);
}
/* 噪点叠加 */
body::after{
  content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .9 0 0 0 0 .9 0 0 0 0 .85 0 0 0 .5 0'/></filter><rect width='200' height='200' filter='url(%23n)'/></svg>");
  opacity:var(--noise-opacity);
}

.mono{font-family:var(--font-mono);font-feature-settings:"ss01","ss02"}

/* ===== 通用控件 ===== */
.wrap{max-width:1400px;margin:0 auto;padding:var(--space-xl) var(--space-lg) var(--space-2xl)}

.label{font-family:var(--font-mono);font-size:var(--fs-mono-xs);font-weight:500;
  letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted)}

input,select,textarea{
  width:100%;background:var(--surface-4);border:1px solid var(--line);
  color:var(--text-primary);padding:var(--space-sm) var(--space-md);
  border-radius:var(--radius);font-family:var(--font-mono);font-size:var(--fs-mono-md);
  transition:border-color .15s,box-shadow .15s;
}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--signal);
  box-shadow:0 0 0 3px var(--signal-glow)}
input::placeholder,textarea::placeholder{color:var(--text-dim)}
select{appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path fill='%23a8a89a' d='M2 4l4 4 4-4'/></svg>");
  background-repeat:no-repeat;background-position:right var(--space-md) center;padding-right:2.25rem}
[data-theme="light"] select{background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path fill='%2386867a' d='M2 4l4 4 4-4'/></svg>")}
textarea{resize:vertical;line-height:1.6}

/* ===== 自建命令菜单下拉（替代原生 select，统一控制台美学） ===== */
.cmd-select{position:relative;width:100%}
/* 触发器：与 input 同款，右侧 chevron */
.cmd-trigger{
  width:100%;display:flex;align-items:center;justify-content:space-between;gap:var(--space-sm);
  background:var(--surface-4);border:1px solid var(--line);color:var(--text-primary);
  padding:var(--space-sm) var(--space-md);border-radius:var(--radius);cursor:pointer;
  font-family:var(--font-mono);font-size:var(--fs-mono-md);text-align:left;
  transition:border-color .15s,box-shadow .15s;
}
.cmd-trigger:hover{border-color:var(--line-bright)}
.cmd-select.open .cmd-trigger{border-color:var(--signal);box-shadow:0 0 0 3px var(--signal-glow)}
.cmd-trigger .cmd-val{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmd-trigger .cmd-val.placeholder{color:var(--text-dim)}
.cmd-chev{flex-shrink:0;color:var(--text-muted);transition:transform .2s, color .15s;font-size:10px;line-height:1}
.cmd-select.open .cmd-chev{transform:rotate(180deg);color:var(--signal)}
/* 弹出菜单：浮层 + 阴影 + 滚动 */
.cmd-menu{
  position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:50;
  background:var(--surface-3);border:1px solid var(--line-bright);border-radius:var(--radius);
  box-shadow:var(--shadow-lg);max-height:70vh;overflow-y:auto;padding:var(--space-xs);
  animation:cmdIn .14s cubic-bezier(.2,.8,.2,1);
}
@keyframes cmdIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
/* 滚动条 */
.cmd-menu::-webkit-scrollbar{width:8px}
.cmd-menu::-webkit-scrollbar-track{background:transparent}
.cmd-menu::-webkit-scrollbar-thumb{background:var(--line-bright);border-radius:4px}
/* 分组标签（vendor） */
.cmd-group-label{
  font-family:var(--font-mono);font-size:var(--fs-mono-xs);font-weight:600;
  letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim);
  padding:var(--space-sm) var(--space-sm) var(--space-xs);position:sticky;top:0;
  background:var(--surface-3);
}
.cmd-group-label:first-child{padding-top:var(--space-xs)}
/* 菜单项 */
.cmd-item{
  display:flex;align-items:center;justify-content:space-between;gap:var(--space-sm);
  padding:var(--space-sm);border-radius:var(--radius);cursor:pointer;
  font-family:var(--font-mono);font-size:var(--fs-mono-md);color:var(--text-secondary);
  transition:background .1s,color .1s;
}
.cmd-item .cmd-item-main{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.cmd-item .cmd-item-tag{flex-shrink:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:30%;font-size:var(--fs-mono-xs);color:var(--text-dim);letter-spacing:.04em}
.cmd-item:hover,.cmd-item.kb-active{background:var(--signal-glow);color:var(--text-primary)}
.cmd-item.kb-active{box-shadow:inset 2px 0 0 var(--signal)}
.cmd-item.selected{color:var(--signal)}
.cmd-item.selected .cmd-item-tag{color:var(--signal-dim)}
.cmd-item.selected::before{content:"▸";margin-right:var(--space-xs);color:var(--signal)}
.cmd-item.disabled{color:var(--text-dim);cursor:default;font-style:italic}
.cmd-item.disabled:hover{background:none;color:var(--text-dim)}

/* 按钮 */
.btn{
  display:inline-flex;align-items:center;gap:var(--space-sm);
  font-family:var(--font-mono);font-size:var(--fs-mono-sm);font-weight:600;
  letter-spacing:.08em;text-transform:uppercase;padding:var(--space-sm) var(--space-lg);
  border-radius:var(--radius);border:1px solid var(--line-bright);background:var(--surface-3);
  color:var(--text-primary);cursor:pointer;transition:all .15s;
}
.btn:hover{border-color:var(--signal);color:var(--signal)}
.btn-primary{background:var(--signal);color:var(--signal-contrast);border-color:var(--signal)}
.btn-primary:hover{filter:brightness(1.08);box-shadow:0 0 24px var(--signal-glow)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn:disabled:hover{border-color:var(--line-bright);color:var(--text-primary);box-shadow:none;background:var(--surface-3)}

/* ===== 顶栏：设备铭牌 ===== */
.console-head{
  display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-lg);
  padding-bottom:var(--space-lg);margin-bottom:var(--space-xl);
  border-bottom:1px solid var(--line);
  flex-wrap:wrap;
}
.brand-mark{display:flex;align-items:baseline;gap:var(--space-md);flex-wrap:wrap}
.brand-name{display:flex;flex-direction:column;gap:2px}
.brand-logo{
  font-family:var(--font-mono);font-weight:700;font-size:var(--fs-display-lg);
  letter-spacing:-.04em;color:var(--text-primary);line-height:1;
}
.brand-logo .dot{color:var(--signal)}
.brand-tag{font-family:var(--font-mono);font-size:var(--fs-mono-sm);
  color:var(--text-secondary);letter-spacing:.05em}
.brand-version{font-family:var(--font-mono);font-size:var(--fs-mono-xs);
  color:var(--text-muted);letter-spacing:.12em;line-height:1}
.device-id{
  font-family:var(--font-mono);font-size:var(--fs-mono-xs);color:var(--text-muted);
  letter-spacing:.1em;text-align:right;line-height:1.7;
}
.device-id code{color:var(--text-secondary);background:var(--surface-2);padding:1px 6px;border-radius:var(--radius)}

/* ===== 导航：信号灯式 Tab ===== */
.nav-bar{display:flex;gap:0;margin-bottom:var(--space-xl);border-bottom:1px solid var(--line)}
.nav-tab{
  display:flex;align-items:center;gap:var(--space-sm);
  font-family:var(--font-mono);font-size:var(--fs-mono-sm);font-weight:500;
  letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);
  padding:var(--space-md) var(--space-lg);background:none;border:none;cursor:pointer;
  border-bottom:2px solid transparent;transition:all .15s;position:relative;
}
.nav-tab:hover{color:var(--text-secondary)}
.nav-tab.active{color:var(--signal);border-bottom-color:var(--signal)}
.nav-tab .idx{font-size:var(--fs-mono-xs);color:var(--text-dim)}
.nav-tab.active .idx{color:var(--signal-dim)}
.nav-led{width:6px;height:6px;border-radius:50%;background:var(--text-dim);transition:all .2s}
.nav-tab.active .nav-led{background:var(--signal);box-shadow:0 0 8px var(--signal-glow)}

/* ===== 通道卡片（CHANNEL STRIP） ===== */
.channel-grid{display:grid;grid-template-columns:1fr;gap:var(--space-md)}
@media(min-width:820px){.channel-grid{grid-template-columns:repeat(3,1fr)}}

.channel{
  background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-lg);
  padding:var(--space-lg);position:relative;
  transition:border-color .2s,transform .2s;
}
.channel::before{
  content:"";position:absolute;top:0;left:0;right:0;height:2px;
  background:var(--line-bright);transition:background .2s;
}
.channel.live::before{background:var(--signal);box-shadow:0 0 12px var(--signal-glow)}
.channel:hover{border-color:var(--line-bright)}

.ch-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-md)}
.ch-id{display:flex;align-items:center;gap:var(--space-sm)}
.ch-led{
  width:8px;height:8px;border-radius:50%;background:var(--text-dim);
  position:relative;transition:background .2s;
}
.channel.live .ch-led{background:var(--signal);box-shadow:0 0 0 3px var(--signal-glow)}
/* 信号灯呼吸（仅 live 通道） */
.channel.live .ch-led::after{
  content:"";position:absolute;inset:-4px;border-radius:50%;
  border:1px solid var(--signal);opacity:0;
  animation:pulse 2s ease-out infinite;
}
@keyframes pulse{0%{opacity:.6;transform:scale(.8)}100%{opacity:0;transform:scale(2)}}

.ch-name{font-family:var(--font-mono);font-weight:600;font-size:var(--fs-mono-md);
  letter-spacing:.05em;color:var(--text-primary);text-transform:uppercase}
.ch-no{font-family:var(--font-mono);font-size:var(--fs-mono-xs);color:var(--text-dim)}

.ch-status{font-family:var(--font-mono);font-size:var(--fs-mono-xs);
  letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);
  padding:2px 8px;border:1px solid var(--line);border-radius:var(--radius);
}
.channel.live .ch-status{color:var(--signal);border-color:var(--signal-dim);background:var(--signal-glow)}

.ch-field{margin-bottom:var(--space-md)}
.ch-field:last-child{margin-bottom:0}
.ch-field .label{display:block;margin-bottom:var(--space-xs)}
.ch-help{font-family:var(--font-mono);font-size:var(--fs-mono-xs);color:var(--text-dim);
  margin-top:var(--space-xs);line-height:1.5;word-break:break-all}
.endpoint-display{
  width:100%;background:var(--surface-2);border:1px solid var(--line);color:var(--text-secondary);
  padding:var(--space-sm) var(--space-md);border-radius:var(--radius);
  font-family:var(--font-mono);font-size:var(--fs-mono-xs);line-height:1.5;
  word-break:break-all;resize:none;cursor:default;
}
.proto-readonly{
  font-family:var(--font-mono);font-size:var(--fs-mono-sm);color:var(--text-secondary);
  padding:var(--space-sm) var(--space-md);background:var(--surface-2);
  border:1px solid var(--line);border-radius:var(--radius);
}

/* 开关：拨杆式 */
.toggle{display:inline-flex;align-items:center;gap:var(--space-sm);cursor:pointer}
.toggle input{display:none}
.toggle-track{
  width:36px;height:18px;background:var(--surface-4);border:1px solid var(--line-bright);
  border-radius:9px;position:relative;transition:all .2s;
}
.toggle-track::after{
  content:"";position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;
  background:var(--text-muted);transition:all .2s;
}
.toggle input:checked + .toggle-track{background:var(--signal-glow);border-color:var(--signal-dim)}
.toggle input:checked + .toggle-track::after{transform:translateX(18px);background:var(--signal)}
.toggle-label{font-family:var(--font-mono);font-size:var(--fs-mono-sm);color:var(--text-secondary)}

/* 全局输出目录 + 保存 */
.master-section{margin-top:var(--space-lg);padding-top:var(--space-lg);border-top:1px dashed var(--line)}
.save-bar{display:flex;align-items:center;gap:var(--space-md);margin-top:var(--space-lg)}
.save-msg{font-family:var(--font-mono);font-size:var(--fs-mono-sm)}
.save-msg.ok{color:var(--signal)} .save-msg.err{color:var(--error)}

/* ===== 试用台 PLAYGROUND ===== */
.pg-grid{display:grid;grid-template-columns:1fr;gap:var(--space-lg)}
@media(min-width:880px){.pg-grid{grid-template-columns:minmax(0,1fr) minmax(0,1.1fr)}}

.pg-panel{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-lg);padding:var(--space-lg)}
.pg-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-md)}
.pg-title{font-family:var(--font-mono);font-size:var(--fs-mono-sm);font-weight:600;
  letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary)}

.modality-switch{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.modality-switch button{
  background:var(--surface-3);border:none;color:var(--text-muted);
  font-family:var(--font-mono);font-size:var(--fs-mono-sm);font-weight:600;
  letter-spacing:.08em;text-transform:uppercase;padding:var(--space-sm);
  cursor:pointer;transition:all .15s;border-right:1px solid var(--line);
}
.modality-switch button:last-child{border-right:none}
.modality-switch button.active{background:var(--signal);color:var(--signal-contrast)}
.modality-switch button:hover:not(.active){color:var(--text-secondary);background:var(--surface-4)}

.field-row{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-md);margin-top:var(--space-md)}
.warn-banner{
  font-family:var(--font-mono);font-size:var(--fs-mono-xs);color:var(--warn);
  background:rgba(245,161,66,.06);border:1px solid rgba(245,161,66,.3);border-radius:var(--radius);
  padding:var(--space-sm) var(--space-md);margin-top:var(--space-md);line-height:1.6;
}

.pg-result{
  background:var(--surface-1);border:1px solid var(--line);border-radius:var(--radius-lg);
  padding:var(--space-lg);min-height:340px;display:flex;flex-direction:column;
}
.result-empty{margin:auto;color:var(--text-dim);text-align:center}
.result-empty .icon{font-size:2.5rem;margin-bottom:var(--space-sm);opacity:.4}
.result-item{border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-sm);background:var(--surface-3);margin-bottom:var(--space-sm)}
.result-item img{max-width:100%;height:auto;border-radius:var(--radius);display:block;margin:0 auto}
.result-item audio{width:100%}
.result-meta{font-family:var(--font-mono);font-size:var(--fs-mono-xs);color:var(--text-muted);margin-top:var(--space-xs)}
.result-summary{font-family:var(--font-mono);font-size:var(--fs-mono-sm);color:var(--text-secondary);white-space:pre-line;line-height:1.6;margin-top:var(--space-sm)}
.err-text{font-family:var(--font-mono);font-size:var(--fs-mono-sm);color:var(--error);margin-top:var(--space-md)}

/* 生成中的扫描线动画 */
.scan-line{position:relative;overflow:hidden}
.scan-line::after{
  content:"";position:absolute;top:0;left:0;right:0;height:2px;
  background:linear-gradient(90deg,transparent,var(--signal),transparent);
  animation:scan 1.4s ease-in-out infinite;
}
@keyframes scan{0%{transform:translateY(0)}100%{transform:translateY(330px)}}

/* ===== 接入向导 PATCH ===== */
.patch-panel{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-lg);padding:var(--space-lg)}
.patch-intro{color:var(--text-secondary);margin-bottom:var(--space-lg);max-width:60ch;line-height:1.6}
.agent-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:var(--space-sm);margin-bottom:var(--space-lg)}
.agent-chip{
  background:var(--surface-3);border:1px solid var(--line-bright);border-radius:var(--radius);padding:var(--space-md);
  font-family:var(--font-mono);font-size:var(--fs-mono-sm);color:var(--text-secondary);
  cursor:pointer;transition:all .15s;text-align:left;letter-spacing:.04em;
}
.agent-chip:hover{border-color:var(--signal-dim);color:var(--text-primary);background:var(--surface-4)}
.agent-chip.active{background:rgba(196,245,66,.08);border-color:var(--signal);color:var(--signal)}

.patch-note{font-family:var(--font-mono);font-size:var(--fs-mono-sm);color:var(--warn);
  background:rgba(245,161,66,.06);border-left:2px solid var(--warn);padding:var(--space-md);
  margin-top:var(--space-md);margin-bottom:var(--space-lg);line-height:1.6}

.code-block{
  background:var(--code-bg);border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-lg);
  font-family:var(--font-mono);font-size:var(--fs-mono-md);color:var(--code-text);
  overflow-x:auto;line-height:1.8;white-space:pre;
}
/* JSON 语法着色 */
.code-block .tok-key{color:var(--signal)}
.code-block .tok-str{color:#e8b878}
.code-block .tok-num{color:#5fb8f5}
.code-block .tok-punc{color:var(--text-muted)}
.code-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-sm)}
.copy-btn{font-family:var(--font-mono);font-size:var(--fs-mono-xs);color:var(--signal);
  background:var(--surface-3);border:1px solid var(--signal-dim);border-radius:var(--radius);
  cursor:pointer;letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;transition:all .15s}
.copy-btn:hover{background:var(--signal-glow);border-color:var(--signal)}

/* ===== 页脚 ===== */
.foot{
  margin-top:var(--space-2xl);padding-top:var(--space-lg);border-top:1px solid var(--line);
  display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--space-md);
}
.foot-text{font-family:var(--font-mono);font-size:var(--fs-mono-xs);color:var(--text-dim);letter-spacing:.08em}
.foot-dots{display:flex;gap:6px}
.foot-dots span{width:6px;height:6px;border-radius:50%;background:var(--text-dim)}
.foot-dots span:first-child{background:var(--signal)}

/* 主题切换平滑：让所有颜色属性在切换时过渡 */
html,body,input,select,textarea,.channel,.pg-panel,.pg-result,.patch-panel,.code-block,
.btn,.agent-chip,.nav-tab,.modality-switch button{
  transition:background-color .25s ease,border-color .25s ease,color .25s ease;
}

/* ===== 顶栏控件：主题 + 语言切换 ===== */
.head-controls{display:flex;align-items:center;gap:var(--space-sm)}
.toggle-group{
  display:inline-flex;border:1px solid var(--line-bright);border-radius:var(--radius);overflow:hidden;
  background:var(--surface-3);
}
.toggle-group button{
  background:none;border:none;cursor:pointer;padding:5px 10px;
  font-family:var(--font-mono);font-size:var(--fs-mono-xs);font-weight:600;
  letter-spacing:.06em;color:var(--text-muted);transition:all .15s;
  border-right:1px solid var(--line);
}
.toggle-group button:last-child{border-right:none}
.toggle-group button.active{background:var(--signal);color:var(--signal-contrast)}
.toggle-group button:hover:not(.active){color:var(--text-secondary);background:var(--surface-4)}
.icon-btn{
  background:var(--surface-3);border:1px solid var(--line-bright);border-radius:var(--radius);
  width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;
  cursor:pointer;color:var(--text-secondary);transition:all .15s;
  font-size:14px;line-height:1;
}
.icon-btn:hover{border-color:var(--signal-dim);color:var(--signal)}

/* ===== 密钥输入框 + 眼睛切换 ===== */
.key-input-wrap{display:flex;align-items:stretch;gap:var(--space-xs)}
.key-input-wrap input{flex:1;width:1%;min-width:0}
/* 按钮跟随输入框高度（覆盖 .icon-btn 的固定 30px 高），宽度保持正方形 */
.key-toggle{align-self:stretch;width:42px;height:auto;padding:0}
.key-toggle svg{width:18px;height:18px}

/* 进入动画 */
[x-cloak]{display:none!important}
.fade-enter{animation:fadeIn .3s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

/* 响应式：窄屏 */
@media(max-width:640px){
  .wrap{padding:var(--space-lg) var(--space-md) var(--space-2xl)}
  .field-row{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="wrap" x-data="prismApp()" x-init="init()" x-cloak>

  <!-- ===== 顶栏：设备铭牌 ===== -->
  <header class="console-head">
    <div class="brand-mark">
      <div class="brand-name">
        <div class="brand-logo">PRISM<span class="dot">·</span>STUDIO</div>
        <div class="brand-version">v${PRISM_VERSION}</div>
      </div>
      <span class="brand-tag" x-text="t.brandTag"></span>
    </div>
    <div class="head-controls">
      <!-- 语言切换 -->
      <div class="toggle-group" role="group" :aria-label="t.langLabel">
        <button :class="lang==='zh' && 'active'" @click="setLang('zh')" aria-label="中文">中</button>
        <button :class="lang==='en' && 'active'" @click="setLang('en')" aria-label="English">EN</button>
      </div>
      <!-- 主题切换 -->
      <button class="icon-btn" @click="toggleTheme()" :aria-label="t.themeLabel"
        :title="t.themeLabel" x-text="theme==='dark' ? '☀' : '☾'"></button>
      <div class="device-id">
        <div>UNIT <code x-text="status.configPath ? status.configPath.split('/').slice(-2).join('/') : '~/.prismstudio'"></code></div>
        <div>OUT <code x-text="status.outputDir ? status.outputDir.split('/').slice(-2).join('/') : 'generated-media'"></code></div>
      </div>
    </div>
  </header>

  <!-- 配置载入失败是写入阻断错误：禁止保存，并允许就地重试。 -->
  <div class="load-error-banner" x-show="loadError" x-cloak x-transition
       role="alert" style="background:var(--surface-3);color:var(--error);border:1px solid var(--error);padding:14px 20px;margin:0;border-radius:0 0 12px 12px;font-size:14px;display:flex;gap:10px;align-items:center;">
    <span style="font-size:18px;">⚠</span>
    <span x-text="t.loadFailed + ' ' + loadError"></span>
    <button class="icon-btn" style="margin-left:auto;width:auto;padding:0 12px;" @click="retryConfigLoad()" :disabled="retryingLoad" x-text="retryingLoad ? t.retrying : t.retry"></button>
  </div>

  <!-- 非关键载入告警：预设/状态/导出失败不影响已安全载入的配置写入。 -->
  <div class="load-error-banner" x-show="auxLoadErrorText()" x-cloak x-transition
       role="status" style="background:var(--surface-2);color:var(--warn);border:1px solid var(--warn);padding:10px 20px;margin:0;border-radius:0 0 12px 12px;font-size:13px;display:flex;gap:10px;align-items:center;">
    <span style="font-size:16px;">⚠</span>
    <span x-text="t.partialLoadFailed + ' ' + auxLoadErrorText()"></span>
    <button class="icon-btn" style="margin-left:auto;width:auto;padding:0 12px;" @click="retryAuxiliaryLoads()" :disabled="retryingAux" x-text="retryingAux ? t.retrying : t.retry"></button>
  </div>

  <!-- ===== 导航 ===== -->
  <nav class="nav-bar">
    <button class="nav-tab" :class="tab==='config' && 'active'" @click="tab='config'">
      <span class="nav-led"></span><span class="idx">01</span> <span x-text="t.navChannels"></span>
    </button>
    <button class="nav-tab" :class="tab==='playground' && 'active'" @click="tab='playground'">
      <span class="nav-led"></span><span class="idx">02</span> <span x-text="t.navPlayground"></span>
    </button>
    <button class="nav-tab" :class="tab==='connect' && 'active'" @click="tab='connect'">
      <span class="nav-led"></span><span class="idx">03</span> <span x-text="t.navPatch"></span>
    </button>
  </nav>

  <!-- ===== 01 CHANNELS：通道配置 ===== -->
  <section x-show="tab==='config'" class="fade-enter">
    <div class="channel-grid">
      <template x-for="m in modalities" :key="m.key">
        <div class="channel" :class="config[m.key]?.enabled && config[m.key]?.apiKey && 'live'">
          <div class="ch-head">
            <div class="ch-id">
              <span class="ch-led"></span>
              <span class="ch-no mono" x-text="'CH ' + m.no"></span>
              <span class="ch-name" x-text="m.name"></span>
            </div>
            <span class="ch-status" x-text="(config[m.key]?.enabled && config[m.key]?.apiKey) ? t.statusLive : t.statusIdle"></span>
          </div>

          <div class="ch-field">
            <label class="toggle">
              <input type="checkbox" x-model="config[m.key].enabled" />
              <span class="toggle-track"></span>
              <span class="toggle-label" x-text="config[m.key]?.enabled ? t.engaged : t.bypassed"></span>
            </label>
          </div>

          <div class="ch-field">
            <span class="label" x-text="modelLabel(m.key)"></span>
            <div class="cmd-select" x-data="dropdown(modelDropdownConfig(m.key))"
                 x-ref="root" :class="open && 'open'"
                 @select="onModelSelect(m.key, $event)">
              <button type="button" class="cmd-trigger" @click="toggle" @keydown="onKeydown"
                      :aria-expanded="open">
                <span class="cmd-val" :class="isPlaceholder && 'placeholder'" x-text="triggerLabel"></span>
                <span class="cmd-chev">▾</span>
              </button>
              <div class="cmd-menu" x-show="open" @click.away="close">
                <template x-for="(grp, gi) in groups" :key="gi">
                  <div>
                    <div class="cmd-group-label" x-show="grp.label && grp.label !== '—'" x-text="grp.label"></div>
                    <template x-for="item in grp.items" :key="item.value">
                      <div class="cmd-item" :class="{ selected: selectedVal===item.value, 'kb-active': isKbActive(item), disabled: item.disabled }"
                           @click="pick(item)" @mouseenter="kbIndex = _flat.findIndex(x => x.value === item.value)">
                        <span class="cmd-item-main" x-text="item.label"></span>
                        <span class="cmd-item-tag" x-show="item.tag" x-text="item.tag"></span>
                      </div>
                    </template>
                  </div>
                </template>
              </div>
            </div>
            <div class="ch-help" x-show="presetHelp(m.key)" x-text="presetHelp(m.key)"></div>
          </div>

          <div class="ch-field">
            <span class="label" x-text="isGoogleCloud(m.key) ? t.labelGcpJson : t.labelApiKey"></span>
            <template x-if="!isGoogleCloud(m.key)">
              <div class="key-input-wrap">
                <input :type="showKey[m.key] ? 'text' : 'password'" x-model="config[m.key].apiKey"
                  :placeholder="config[m.key]?.apiKey?.includes('****') ? t.phKeyStored : t.phKeyPaste" />
                <button type="button" class="icon-btn key-toggle"
                  @click="showKey[m.key] = !showKey[m.key]"
                  :title="showKey[m.key] ? t.hideKey : t.showKey"
                  :aria-label="showKey[m.key] ? t.hideKey : t.showKey">
                  <!-- 睁眼：明文显示中 -->
                  <svg x-show="showKey[m.key]" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
                  <!-- 闭眼：隐藏中 -->
                  <svg x-show="!showKey[m.key]" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.12 9.12 0 0 0 5.39-1.61"/><path d="M2 2l20 20"/></svg>
                </button>
              </div>
            </template>
            <template x-if="isGoogleCloud(m.key)">
              <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start;width:100%">
                <div style="display:flex;align-items:center;gap:12px;width:100%;flex-wrap:wrap">
                  <button type="button" class="btn" @click="document.getElementById('fileInput_' + m.key)?.click()">
                    <span x-text="config[m.key]?.apiKey ? t.btnSelectGcpJsonChange : t.btnSelectGcpJson"></span>
                  </button>
                  <input type="file" :id="'fileInput_' + m.key" accept=".json" @change="onFileChange($event, m.key)" style="display:none" />
                  <template x-if="config[m.key]?.apiKey">
                    <span style="font-size:var(--fs-mono-xs);color:#58a6ff;font-family:var(--font-mono)" x-text="getGcpCredentialDesc(config[m.key].apiKey)"></span>
                  </template>
                </div>
                <span style="font-size:var(--fs-mono-xs);color:var(--text-dim)" x-text="t.gcpJsonHelp"></span>
              </div>
            </template>
          </div>

          <!-- 完整请求地址（只读展示，引擎最终请求打到的地址） -->
          <div class="ch-field">
            <span class="label" x-text="t.labelEndpoint"></span>
            <textarea readonly rows="2" class="endpoint-display"
              x-text="displayEndpoint(m.key)"
              :placeholder="t.phNoEndpoint"></textarea>
          </div>

          <!-- 协议（只读展示，custom 模式见下方可编辑下拉） -->
          <div class="ch-field" x-show="config[m.key].presetId !== 'custom' && protocolDisplayLabel(m.key)">
            <span class="label" x-text="t.labelProtocol"></span>
            <div class="proto-readonly" x-text="protocolDisplayLabel(m.key)"></div>
          </div>

          <template x-if="config[m.key].presetId === 'custom'">
            <div class="ch-field">
              <span class="label" x-text="t.labelModelProto"></span>
              <input type="text" x-model="config[m.key].model" :placeholder="t.phModel" style="margin-bottom:6px" />
              <input type="text" x-model="config[m.key].baseUrl" :placeholder="t.phCustomBaseUrl" style="margin-bottom:6px" />
              <div class="cmd-select" x-data="dropdown(protocolDropdownConfig(m.key))"
                   @select="onProtocolSelect(m.key, $event)">
                <button type="button" class="cmd-trigger" @click="toggle" @keydown="onKeydown"
                        :aria-expanded="open">
                  <span class="cmd-val" :class="isPlaceholder && 'placeholder'" x-text="triggerLabel"></span>
                  <span class="cmd-chev">▾</span>
                </button>
                <div class="cmd-menu" x-show="open" @click.away="close">
                  <template x-for="item in groups[0].items" :key="item.value">
                    <div class="cmd-item" :class="{ selected: selectedVal===item.value, 'kb-active': isKbActive(item) }"
                         @click="pick(item)" @mouseenter="kbIndex = _flat.findIndex(x => x.value === item.value)">
                      <span class="cmd-item-main" x-text="item.label"></span>
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>

    <!-- 主输出 + 保存 -->
    <div class="master-section">
      <div class="ch-field" style="margin:0">
        <span class="label" x-text="t.labelOutputDir"></span>
        <input type="text" x-model="config.outputDir" :placeholder="t.phOutputDir" />
      </div>
      <div class="save-bar">
        <button class="btn btn-primary" @click="saveConfig()" :disabled="saving || !!loadError">
          <span x-show="!saving" x-text="t.btnCommit"></span>
          <span x-show="saving" x-text="t.btnCommitting"></span>
        </button>
        <span class="save-msg" :class="saveErr ? 'err' : 'ok'" x-show="saveMsg" x-text="saveMsg"></span>
      </div>
    </div>
  </section>

  <!-- ===== 02 PLAYGROUND：试用台 ===== -->
  <section x-show="tab==='playground'" class="fade-enter">
    <div class="pg-grid">
      <!-- 左：控制 -->
      <div class="pg-panel">
        <div class="pg-head">
          <span class="pg-title" x-text="t.pgTitle"></span>
        </div>

        <div class="modality-switch">
          <template x-for="m in modalities" :key="m.key">
            <button :class="test.modality===m.key && 'active'" @click="test.modality=m.key" x-text="m.name"></button>
          </template>
        </div>

        <div style="margin-top:var(--space-md)">
          <span class="label"><span x-text="t.labelPrompt"></span> <span x-show="test.modality==='audio'" x-text="t.promptSuffix"></span></span>
          <textarea x-model="test.prompt" rows="4" :placeholder="t.phPrompt"></textarea>
        </div>

        <div class="field-row">
          <div x-show="test.modality==='image'">
            <span class="label" x-text="t.labelCount"></span>
            <input type="number" min="1" max="4" x-model.number="test.numberOfImages" />
          </div>
          <div x-show="test.modality==='image'">
            <span class="label" x-text="t.labelSize"></span>
            <input type="text" x-model="test.size" placeholder="1024x1024" />
          </div>
          <div x-show="test.modality==='video'">
            <span class="label" x-text="t.labelDuration"></span>
            <input type="number" min="1" max="60" x-model.number="test.duration" />
          </div>
          <div x-show="test.modality==='audio'">
            <span class="label" x-text="t.labelTask"></span>
            <div class="cmd-select" x-data="dropdown(taskDropdownConfig())"
                 x-ref="root" :class="open && 'open'"
                 @select="onTaskSelect($event)">
              <button type="button" class="cmd-trigger" @click="toggle" @keydown="onKeydown" :aria-expanded="open">
                <span class="cmd-val" :class="isPlaceholder && 'placeholder'" x-text="triggerLabel"></span>
                <span class="cmd-chev">▾</span>
              </button>
              <div class="cmd-menu" x-show="open" @click.away="close">
                <template x-for="item in groups[0].items" :key="item.value">
                  <div class="cmd-item" :class="{ selected: selectedVal===item.value, 'kb-active': isKbActive(item) }"
                       @click="pick(item)" @mouseenter="kbIndex = _flat.findIndex(x => x.value === item.value)">
                    <span class="cmd-item-main" x-text="item.label"></span>
                  </div>
                </template>
              </div>
            </div>
          </div>
          <div x-show="test.modality==='audio' && test.task==='tts'">
            <span class="label" x-text="t.labelVoice"></span>
            <input type="text" x-model="test.voice" :placeholder="t.phVoice" />
          </div>
        </div>

        <div class="warn-banner" x-show="test.modality && !isReady(test.modality)" x-text="t.warnNotLive">
        </div>

        <div style="margin-top:var(--space-lg)">
          <span class="label"><span x-text="t.labelTempKey"></span> <span style="text-transform:none;color:var(--text-dim)" x-text="t.tempKeyHint"></span></span>
          <div class="key-input-wrap">
            <input :type="showTempKey ? 'text' : 'password'" x-model="test.tempKey" :placeholder="t.phTempKey" />
            <button type="button" class="icon-btn key-toggle"
              @click="showTempKey = !showTempKey"
              :title="showTempKey ? t.hideKey : t.showKey"
              :aria-label="showTempKey ? t.hideKey : t.showKey">
              <svg x-show="showTempKey" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg x-show="!showTempKey" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.12 9.12 0 0 0 5.39-1.61"/><path d="M2 2l20 20"/></svg>
            </button>
          </div>
        </div>

        <button class="btn btn-primary" style="margin-top:var(--space-lg);width:100%;justify-content:center"
          @click="runTest()" :disabled="testing">
          <span x-show="!testing" x-text="t.btnGenerate"></span>
          <span x-show="testing" x-text="t.btnGenerating"></span>
        </button>
        <p class="err-text" x-show="testError" x-text="testError"></p>
      </div>

      <!-- 右：输出 -->
      <div class="pg-result" :class="testing && 'scan-line'">
        <template x-if="!testResult && !testing">
          <div class="result-empty">
            <div class="icon">▦</div>
            <div class="mono" style="font-size:var(--fs-mono-sm);letter-spacing:.1em" x-text="t.signalOutput"></div>
            <div class="mono" style="font-size:var(--fs-mono-xs);color:var(--text-dim);margin-top:6px" x-text="t.awaitingInput"></div>
          </div>
        </template>

        <template x-if="testResult">
          <div>
            <template x-for="(item, i) in testResult.items" :key="i">
              <div class="result-item">
                <template x-if="item.mediaType.startsWith('image/')">
                  <img :src="item.dataUri" alt="generated" />
                </template>
                <template x-if="item.mediaType.startsWith('audio/')">
                  <audio :src="item.dataUri" controls></audio>
                </template>
                <template x-if="item.mediaType.startsWith('video/')">
                  <div class="mono" style="font-size:var(--fs-mono-sm);color:var(--text-secondary);word-break:break-all">
                    ▸ <span x-text="item.localPath"></span>
                  </div>
                </template>
                <div class="result-meta" x-text="item.mediaType"></div>
              </div>
            </template>
            <div class="result-summary" x-text="testResult.text"></div>
          </div>
        </template>
      </div>
    </div>
  </section>

  <!-- ===== 03 PATCH：接入向导 ===== -->
  <section x-show="tab==='connect'" class="fade-enter">
    <div class="patch-panel">
      <p class="pg-title" style="margin-bottom:var(--space-sm)" x-text="t.patchTitle"></p>
      <p class="patch-intro" x-text="t.patchIntro"></p>

      <div class="agent-grid">
        <template x-for="a in agents" :key="a.id">
          <button class="agent-chip" :class="exportAgent===a.id && 'active'" @click="exportAgent=a.id; refreshExport()" x-text="a.label"></button>
        </template>
      </div>

      <div class="patch-note" x-show="exportData?.note" x-text="exportData?.note"></div>

      <div class="code-head">
        <span class="label" x-text="t.configSnippet"></span>
        <button class="copy-btn" @click="copyExport()" x-text="copied ? t.copied : t.copy"></button>
      </div>
      <pre class="code-block" x-html="highlightedExport"></pre>
    </div>
  </section>

  <!-- ===== 页脚 ===== -->
  <footer class="foot">
    <span class="foot-text" x-text="t.footer"></span>
    <div class="foot-dots"><span></span><span></span><span></span></div>
  </footer>
</div>

<script>
// 协议 × 模态 → 主提交请求路径后缀（引擎实际拼接的路径，供展示"完整请求地址"用）。
// 多模态协议（dashscope-async / zhipu-async / minimax）按模态给出不同路径；
// 动态路径（Gemini 走 GCP token 交换、dashscope-sync 按 model 分两路）留空，展示时退化为只显示 baseUrl。
const PROTOCOL_ENDPOINT_PATH = {
  'openai-images': { image: '/images/generations' },
  'gemini-generate-content': {},                 // 动态：buildGoogleGenerateContentRequestTarget 构造
  'dashscope-async': { image: '/services/aigc/image-generation/generation', video: '/services/aigc/video-generation/video-synthesis' },
  'minimax': { image: '/image_generation', video: '/video_generation', audio: '/t2a_v2' },
  'stability': {},                               // baseUrl 本身已含完整路径 + /{model}
  'tencent-hunyuan-async': {},                   // 动态：按图/视频 + 路径前缀
  'midjourney': { image: '/mj/submit/imagine' },
  'volcengine-async': { video: '/contents/generations/tasks' },
  'kling-async': { video: '/v1/videos/text2video' },
  'zhipu-async': { image: '/images/generations', video: '/videos/generations', audio: '/audio/speech' },
  'google-interactions': {},                     // 动态 GCP
  'volcengine-tts': { audio: '/api/v3/tts/create' },
  'volcengine-plan-tts': { audio: '/api/v3/plan/tts/unidirectional' },
  'dashscope-sync': {},                          // 动态：按 model 选 multimodal-generation 或 text2audio
  'minimax-tts-async': { audio: '/t2a_async_v2' },
  'minimax-voice-clone': { audio: '/voice_clone' },
};

// custom 模式协议可读名映射：label 人类可读，value 为内部 protocol（引擎分派用）。按语言 × 模态组织。
const PROTOCOL_OPTIONS = {
  zh: {
    image: [
      { value: 'openai-images', label: 'OpenAI 兼容' },
      { value: 'gemini-generate-content', label: 'Google Gemini' },
      { value: 'dashscope-async', label: '阿里 DashScope（异步）' },
      { value: 'minimax', label: 'MiniMax' },
      { value: 'stability', label: 'Stability' },
      { value: 'tencent-hunyuan-async', label: '腾讯混元（异步）' },
      { value: 'midjourney', label: 'Midjourney' },
    ],
    video: [
      { value: 'volcengine-async', label: '火山方舟（异步）' },
      { value: 'kling-async', label: '可灵（异步）' },
      { value: 'zhipu-async', label: '智谱（异步）' },
      { value: 'dashscope-async', label: '阿里 DashScope（异步）' },
      { value: 'minimax', label: 'MiniMax' },
      { value: 'tencent-hunyuan-async', label: '腾讯混元（异步）' },
      { value: 'google-interactions', label: 'Google Interactions' },
    ],
    audio: [
      { value: 'volcengine-tts', label: '火山语音 TTS' },
      { value: 'volcengine-plan-tts', label: '火山 Agent Plan TTS' },
      { value: 'zhipu-async', label: '智谱' },
      { value: 'dashscope-sync', label: '阿里 DashScope（同步）' },
      { value: 'minimax', label: 'MiniMax' },
      { value: 'minimax-tts-async', label: 'MiniMax TTS（异步）' },
      { value: 'minimax-voice-clone', label: 'MiniMax 声音克隆' },
    ],
  },
  en: {
    image: [
      { value: 'openai-images', label: 'OpenAI-compatible' },
      { value: 'gemini-generate-content', label: 'Google Gemini' },
      { value: 'dashscope-async', label: 'Alibaba DashScope (async)' },
      { value: 'minimax', label: 'MiniMax' },
      { value: 'stability', label: 'Stability' },
      { value: 'tencent-hunyuan-async', label: 'Tencent Hunyuan (async)' },
      { value: 'midjourney', label: 'Midjourney' },
    ],
    video: [
      { value: 'volcengine-async', label: 'Volcengine Ark (async)' },
      { value: 'kling-async', label: 'Kling (async)' },
      { value: 'zhipu-async', label: 'Zhipu (async)' },
      { value: 'dashscope-async', label: 'Alibaba DashScope (async)' },
      { value: 'minimax', label: 'MiniMax' },
      { value: 'tencent-hunyuan-async', label: 'Tencent Hunyuan (async)' },
      { value: 'google-interactions', label: 'Google Interactions' },
    ],
    audio: [
      { value: 'volcengine-tts', label: 'Volcengine TTS' },
      { value: 'volcengine-plan-tts', label: 'Volcengine Agent Plan TTS' },
      { value: 'zhipu-async', label: 'Zhipu' },
      { value: 'dashscope-sync', label: 'Alibaba DashScope (sync)' },
      { value: 'minimax', label: 'MiniMax' },
      { value: 'minimax-tts-async', label: 'MiniMax TTS (async)' },
      { value: 'minimax-voice-clone', label: 'MiniMax Voice Clone' },
    ],
  },
};

/**
 * 自建命令菜单下拉组件（替代原生 <select>，统一控制台美学）。
 *
 * 用法：x-data="dropdown({ getValue: ()=>当前值, getGroups: ()=>[...], placeholder })"
 *   getGroups(): [{ label?(可选), items:[{value,label,tag?(可选),disabled?}] }]
 * value/groups 通过 getter 从父级响应式读取，语言切换/外部改动自动同步。
 * 触发选中：组件 $dispatch('select', {value}) 冒泡，外层 @select 监听。
 * 键盘：ArrowDown/Up 移动高亮，Enter 选中，Esc 关闭。
 * 鼠标：hover 高亮，click 选中；点击外部自动关闭。
 */
function dropdown(initial) {
  return {
    open: false,
    kbIndex: -1,
    placeholder: initial.placeholder || '',
    _getValue: initial.getValue || (()=>''),
    _getGroups: initial.getGroups || (()=>[]),

    // 响应式：每次访问都从父级读最新值/分组
    get selectedVal() { return this._getValue() },
    get groups() { return this._getGroups() },
    get _flat() {
      const out = []
      for (const g of this.groups) for (const it of (g.items || [])) if (!it.disabled) out.push(it)
      return out
    },
    get triggerLabel() {
      const v = this.selectedVal
      for (const g of this.groups) {
        const f = (g.items || []).find(i => i.value === v)
        if (f) return f.label
      }
      return this.placeholder
    },
    get isPlaceholder() { return !this.selectedVal },
    toggle() { this.open ? this.close() : this.openMenu() },
    openMenu() {
      this.open = true
      const idx = this._flat.findIndex(i => i.value === this.selectedVal)
      this.kbIndex = idx >= 0 ? idx : (this._flat.length ? 0 : -1)
      this.$nextTick(() => this.scrollKbIntoView())
    },
    close() { this.open = false },
    pick(item) {
      if (item.disabled) return
      this.close()
      this.$dispatch('select', { value: item.value })
    },
    onKeydown(e) {
      if (!this.open) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openMenu() }
        return
      }
      const n = this._flat.length
      if (n === 0) return
      if (e.key === 'ArrowDown') { e.preventDefault(); this.kbIndex = (this.kbIndex + 1) % n; this.scrollKbIntoView() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.kbIndex = (this.kbIndex - 1 + n) % n; this.scrollKbIntoView() }
      else if (e.key === 'Enter') { e.preventDefault(); if (this.kbIndex >= 0) this.pick(this._flat[this.kbIndex]) }
      else if (e.key === 'Escape') { e.preventDefault(); this.close() }
    },
    scrollKbIntoView() {
      this.$nextTick(() => {
        const el = this.$refs.root && this.$refs.root.querySelector('.cmd-item.kb-active')
        if (el) el.scrollIntoView({ block: 'nearest' })
      })
    },
    isKbActive(item) {
      if (this.kbIndex < 0 || this.kbIndex >= this._flat.length) return false
      return this._flat[this.kbIndex].value === item.value
    },
  }
}

function prismApp() {
  return {
    tab: 'config',
    // ===== 主题与语言（持久化，默认 dark + 中文） =====
    theme: localStorage.getItem('prism-theme') || 'dark',
    lang: localStorage.getItem('prism-lang') || 'zh',

    // ===== i18n 文案字典 =====
    dict: {
      zh: {
        brandTag: '// 多模态生成控制台',
        langLabel: '语言', themeLabel: '切换主题',
        navChannels: '通道', navPlayground: '试用台', navPatch: '接入',
        statusLive: '就绪', statusIdle: '空闲',
        engaged: '已启用', bypassed: '未启用',
        modality: { image: '图像', video: '视频', audio: '音频' },
        modelLabel: { image: '生图模型', video: '视频模型', audio: '音频模型' },
        phSelectModel: '请选择模型',
        customModel: '自定义（手动填写）',
        labelApiKey: 'API 密钥',
        showKey: '显示密钥', hideKey: '隐藏密钥',
        labelEndpoint: '请求地址',
        phNoEndpoint: '选择模型后显示',
        labelProtocol: '接口协议',
        phSelectProtocol: '选择接口协议',
        phCustomBaseUrl: '完整 base url（如 https://api.example.com/v1）',
        labelGcpJson: 'Google Cloud JSON 凭证',
        btnSelectGcpJson: '选择 JSON 凭证文件',
        btnSelectGcpJsonChange: '重新选择 JSON 凭证文件',
        gcpJsonHelp: '选择后系统会读取 JSON 内容作为 API 凭证进行保存。',
        phKeyStored: '已保存 · 重新输入可覆盖', phKeyPaste: '在此粘贴密钥',
        labelModelProto: '模型 ID',
        phModel: '模型 ID', phProtocol: '协议（如 openai-images）', phBaseUrl: 'base url（可选）',
        labelOutputDir: '主输出目录',
        phOutputDir: '留空 = ~/.prismstudio/generated-media',
        btnCommit: '▸ 提交配置', btnCommitting: '提交中…',
        committed: '✓ 已提交', commitFailed: '提交失败',
        autosaved: '✓ 已自动保存',
        loadFailed: '配置载入失败，已禁止保存以保护现有配置：',
        partialLoadFailed: '部分辅助信息载入失败，不影响配置保存：',
        retry: '重试', retrying: '重试中…',
        pgTitle: '◢ 信号发生器',
        labelPrompt: '提示词', promptSuffix: '/ 文本', phPrompt: '描述要生成的内容…',
        labelCount: '数量', labelSize: '尺寸', labelDuration: '时长（秒）',
        labelTask: '任务', taskTts: 'tts · 语音', taskMusic: '音乐', taskClone: '克隆',
        labelVoice: '音色', phVoice: '如 Cherry',
        warnNotLive: '⚠ 通道未就绪 — 该模态尚未保存密钥。请到「通道」配置，或在下方临时填入密钥进行一次性测试。',
        labelTempKey: '临时密钥', tempKeyHint: '（一次性，不保存）', phTempKey: '留空 = 使用已保存密钥',
        btnGenerate: '▸ 生成', btnGenerating: '生成中… 视频可能需要 1–5 分钟',
        generationFailed: '生成失败',
        signalOutput: '信号输出', awaitingInput: '等待输入',
        patchTitle: '◢ 接线盘',
        patchIntro: '请先在「通道」配置好各模态，再将本控制台接入你的 agent。选择下方目标并复制配置片段。',
        configSnippet: 'mcpServers.json', copy: '⧉ 复制', copied: '✓ 已复制',
        footer: 'Prismstudio · MIT · 多模态生成控制台',
        agents: { claude:'Claude Desktop', cursor:'Cursor', cline:'Cline', windsurf:'Windsurf', generic:'通用 stdio' },
      },
      en: {
        brandTag: '// multi-modal generation console',
        langLabel: 'Language', themeLabel: 'Toggle theme',
        navChannels: 'Channels', navPlayground: 'Playground', navPatch: 'Patch',
        statusLive: 'LIVE', statusIdle: 'IDLE',
        engaged: 'ENABLED', bypassed: 'DISABLED',
        modality: { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO' },
        modelLabel: { image: 'Image Model', video: 'Video Model', audio: 'Audio Model' },
        phSelectModel: 'Select a model',
        customModel: 'Custom (manual)',
        labelApiKey: 'API Key',
        showKey: 'Show key', hideKey: 'Hide key',
        labelEndpoint: 'Endpoint',
        phNoEndpoint: 'shown after selecting a model',
        labelProtocol: 'Protocol',
        phSelectProtocol: 'Select protocol',
        phCustomBaseUrl: 'full base url (e.g. https://api.example.com/v1)',
        labelGcpJson: 'Google Cloud JSON',
        btnSelectGcpJson: 'Select JSON File',
        btnSelectGcpJsonChange: 'Change JSON File',
        gcpJsonHelp: 'After selection, the system reads the JSON content to save as API credentials.',
        phKeyStored: 'stored · retype to overwrite', phKeyPaste: 'paste key here',
        labelModelProto: 'Model ID',
        phModel: 'model-id', phProtocol: 'protocol (e.g. openai-images)', phBaseUrl: 'base url (optional)',
        labelOutputDir: 'Master Output Directory',
        phOutputDir: 'blank = ~/.prismstudio/generated-media',
        btnCommit: '▸ Commit Config', btnCommitting: 'committing…',
        committed: '✓ COMMITTED', commitFailed: 'commit failed',
        autosaved: '✓ autosaved',
        loadFailed: 'Config failed to load. Saving is disabled to protect existing data:',
        partialLoadFailed: 'Some auxiliary data failed to load. Config saving remains available:',
        retry: 'Retry', retrying: 'Retrying…',
        pgTitle: '◢ Signal Generator',
        labelPrompt: 'Prompt', promptSuffix: '/ Text', phPrompt: 'describe what to generate…',
        labelCount: 'Count', labelSize: 'Size', labelDuration: 'Duration (s)',
        labelTask: 'Task', taskTts: 'tts · speech', taskMusic: 'music', taskClone: 'clone',
        labelVoice: 'Voice', phVoice: 'e.g. Cherry',
        warnNotLive: '⚠ CHANNEL NOT LIVE — this modality has no stored key. Set it in Channels, or paste a key below for one-shot testing.',
        labelTempKey: 'Temp Key', tempKeyHint: '(one-shot, not stored)', phTempKey: 'blank = use stored key',
        btnGenerate: '▸ Generate', btnGenerating: 'rendering… video may take 1–5 min',
        generationFailed: 'generation failed',
        signalOutput: 'SIGNAL OUTPUT', awaitingInput: 'awaiting input',
        patchTitle: '◢ Patch Bay',
        patchIntro: 'Configure your channels first, then route this console into your agent. Pick a target below and copy the routing snippet.',
        configSnippet: 'mcpServers.json', copy: '⧉ COPY', copied: '✓ COPIED',
        footer: 'Prismstudio · MIT · multi-modal generation console',
        agents: { claude:'Claude Desktop', cursor:'Cursor', cline:'Cline', windsurf:'Windsurf', generic:'Generic stdio' },
      },
    },

    // 当前语言文案（getter，随 lang 变化）
    get t() { return this.dict[this.lang] || this.dict.zh; },
    // agent 列表（label 取当前语言）
    get agents() {
      const a = this.t.agents;
      return [
        { id: 'claude', label: a.claude }, { id: 'cursor', label: a.cursor },
        { id: 'cline', label: a.cline }, { id: 'windsurf', label: a.windsurf },
        { id: 'generic', label: a.generic },
      ];
    },

    // 模态列表：name 随语言变化（中文显示图像/视频/音频，英文显示 IMAGE/VIDEO/AUDIO）
    get modalities() {
      const m = this.t.modality;
      return [
        { key: 'image', no: '01', name: m.image },
        { key: 'video', no: '02', name: m.video },
        { key: 'audio', no: '03', name: m.audio },
      ];
    },
    // 按模态返回"模型字段名"（生图模型 / 视频模型 / 音频模型）
    modelLabel(key) { return this.t.modelLabel[key]; },

    // 构建模型下拉的配置（按 vendor 分组 + 末尾自定义项），供 dropdown 组件消费
    // 通过 getter 从父级响应式读取，语言切换/外部改动自动同步
    modelDropdownConfig(key) {
      const self = this
      return {
        placeholder: self.t.phSelectModel,
        getValue: () => self.config[key]?.presetId || '',
        getGroups: () => {
          const byVendor = {}
          for (const p of (self.presets[key] || [])) {
            const cleanLabel = p.label.includes('·') ? p.label.replace(/^[^·]+·\s*/, '') : p.label;
            (byVendor[p.vendor] = byVendor[p.vendor] || []).push({
              value: p.id, label: cleanLabel, tag: p.protocol,
            })
          }
          const groups = Object.entries(byVendor).map(([vendor, items]) => ({ label: vendor, items }))
          groups.push({ label: '—', items: [{ value: 'custom', label: self.t.customModel }] })
          return groups
        },
      }
    },
    // 试用台任务下拉配置（tts/music/clone）
    taskDropdownConfig() {
      const self = this
      return {
        placeholder: '',
        getValue: () => self.test.task,
        getGroups: () => [{ items: [
          { value: 'tts', label: self.t.taskTts },
          { value: 'music', label: self.t.taskMusic },
          { value: 'clone', label: self.t.taskClone },
        ]}],
      }
    },
    // custom 模式协议下拉配置：按模态过滤，显示人类可读名，值写内部 protocol。
    protocolDropdownConfig(key) {
      const self = this
      return {
        placeholder: self.t.phSelectProtocol,
        getValue: () => self.config[key]?.protocol || '',
        getGroups: () => [{ items: (PROTOCOL_OPTIONS[self.lang] && PROTOCOL_OPTIONS[self.lang][key]) || [] }],
      }
    },
    onProtocolSelect(key, e) { this.config[key].protocol = e.detail.value; },
    // dropdown 选中事件 → 写回 config
    onModelSelect(key, e) {
      this.config[key].presetId = e.detail.value
      this.onPresetChange(key)
    },
    onTaskSelect(e) { this.test.task = e.detail.value; },
    isGoogleCloud(key) {
      const pid = this.config[key]?.presetId
      if (!pid) return false
      const p = (this.presets[key] || []).find(x => x.id === pid)
      return p && p.vendor === 'Google Cloud Service (Vertex)'
    },
    onFileChange(e, key) {
      const file = e.target.files[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = (evt) => {
        try {
          const text = evt.target.result
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed === 'object') {
            this.config[key].apiKey = text
          } else {
            alert(this.lang === 'zh' ? '无效的 JSON 文件' : 'Invalid JSON file')
          }
        } catch (err) {
          alert((this.lang === 'zh' ? '解析 JSON 失败：' : 'Failed to parse JSON: ') + err.message)
        }
      }
      reader.readAsText(file)
    },
    getGcpCredentialDesc(key) {
      if (!key) return ''
      if (key.startsWith('JSON:')) {
        const parts = key.split(':')
        const type = parts[1] === 'service_account' ? (this.lang === 'zh' ? '服务账号' : 'Service Account') : (this.lang === 'zh' ? '用户账号' : 'Authorized User')
        const projectId = parts[2]?.replace('·****', '') || ''
        return this.lang === 'zh' ? '已导入 GCP ' + type + ' (' + projectId + ')' : 'Imported GCP ' + type + ' (' + projectId + ')'
      }
      try {
        const parsed = JSON.parse(key)
        const type = parsed.type === 'service_account' ? (this.lang === 'zh' ? '服务账号' : 'Service Account') : (this.lang === 'zh' ? '用户账号' : 'Authorized User')
        const projectId = parsed.project_id || parsed.quota_project_id || 'unknown'
        return this.lang === 'zh' ? '已选择 GCP ' + type + ' (' + projectId + ')' : 'Selected GCP ' + type + ' (' + projectId + ')'
      } catch {}
      return this.lang === 'zh' ? '已选择 JSON 文件' : 'Selected JSON file'
    },
    config: { image: {enabled:false,presetId:'',apiKey:''}, video: {enabled:false,presetId:'',apiKey:''}, audio: {enabled:false,presetId:'',apiKey:''}, outputDir: '' },
    // 各模态 API Key 是否明文显示（内存态，不存 config.json）
    showKey: { image:false, video:false, audio:false },
    showTempKey: false,
    // 各模态切换前的 presetId（内存态，不存 config.json，供 onPresetChange 判断新旧）
    _lastPreset: { image:'', video:'', audio:'' },
    presets: { image: [], video: [], audio: [] },
    status: {},
    saving: false, saveMsg: '', saveErr: false,
    // 只有配置载入失败才阻断写入；预设、状态和导出各自降级，不牵连配置保存。
    loadError: '',
    presetsError: '', statusError: '', exportError: '',
    retryingLoad: false, retryingAux: false,

    test: { modality: 'image', prompt: '', size: '', numberOfImages: 1, duration: 5, task: 'tts', voice: '', tempKey: '' },
    testing: false, testResult: null, testError: '',

    exportAgent: 'claude', exportData: null, exportText: '', copied: false,

    // ===== 主题与语言切换 =====
    setLang(l) {
      this.lang = l;
      try { localStorage.setItem('prism-lang', l); } catch(e){}
      document.documentElement.setAttribute('lang', l === 'zh' ? 'zh-CN' : 'en');
    },
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      this.applyTheme();
    },
    applyTheme() {
      document.documentElement.setAttribute('data-theme', this.theme);
      try { localStorage.setItem('prism-theme', this.theme); } catch(e){}
    },

    // JSON 语法高亮：单次分词，回调判断类型，一次生成 HTML
    get highlightedExport() {
      if (!this.exportText) return ''
      const esc = this.exportText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      return esc.replace(
        /("(?:[^"\\\\]|\\\\.)*")(\\s*:)|("(?:[^"\\\\]|\\\\.)*")|(-?\\d+(?:\\.\\d+)?)|([{}[\\],])/g,
        (m, key, colon, str, num, punc) => {
          if (key) return '<span class="tok-key">' + key + '</span>' + colon
          if (str) return '<span class="tok-str">' + str + '</span>'
          if (num) return '<span class="tok-num">' + num + '</span>'
          if (punc) return '<span class="tok-punc">' + punc + '</span>'
          return m
        }
      )
    },

    async init() {
      this.applyTheme();
      await this.loadInitialData();
    },
    async loadInitialData() {
      // 预设优先载入，供配置中的 vendor API Key 记忆逻辑使用；失败时允许配置继续载入。
      try {
        await this.loadPresets();
        this.presetsError = '';
      } catch (e) {
        this.presetsError = (e && e.message) ? e.message : String(e);
      }

      try {
        await this.loadConfig();
        this.loadError = '';
      } catch (e) {
        // 只有配置本体未安全载入时才禁止写入，防止默认 stub 覆盖磁盘配置。
        this.loadError = (e && e.message) ? e.message : String(e);
        return;
      }

      this.installAutoSaveWatchers();
      await Promise.all([this.refreshStatus(), this.refreshExport()]);
    },
    installAutoSaveWatchers() {
      if (this._watchersInstalled) return;
      // 配置载入完成后，开启自动保存监听。loadConfig 末尾把 _loaded 置 true。
      // 监听每个模态的关键字段 + outputDir，任一变化即 debounce 自动保存。
      const watchedPaths = [];
      for (const k of ['image','video','audio']) {
        for (const f of ['enabled','presetId','apiKey','model','protocol','baseUrl','audioTask']) {
          watchedPaths.push('config.' + k + '.' + f);
        }
      }
      watchedPaths.push('config.outputDir');
      for (const p of watchedPaths) {
        this.$watch(p, () => this.scheduleAutoSave());
      }
      this._watchersInstalled = true;
    },
    async retryConfigLoad() {
      if (this.retryingLoad) return;
      this.retryingLoad = true;
      try { await this.loadInitialData(); }
      finally { this.retryingLoad = false; }
    },
    auxLoadErrorText() {
      return [this.presetsError, this.statusError, this.exportError].filter(Boolean).join(' · ');
    },
    async retryAuxiliaryLoads() {
      if (this.retryingAux) return;
      this.retryingAux = true;
      try {
        await Promise.all([
          (async () => {
            try { await this.loadPresets(); this.presetsError = ''; }
            catch (e) { this.presetsError = (e && e.message) ? e.message : String(e); }
          })(),
          this.refreshStatus(),
          this.refreshExport(),
        ]);
      } finally {
        this.retryingAux = false;
      }
    },
    async loadConfig() {
      this._restoring = true;
      try {
        const r = await fetch('/api/config');
        if (!r.ok) throw new Error(this.t.commitFailed + ' (' + r.status + ')');
        const data = await r.json();
        // 服务器错误体或非对象响应不能当 config 使用，否则可能把默认 stub 覆盖回磁盘。
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) {
          throw new Error(data?.error || this.t.commitFailed);
        }
        this.config = data;
        for (const k of ['image','video','audio']) {
          if (!this.config[k] || typeof this.config[k] !== 'object' || Array.isArray(this.config[k])) this.config[k] = {enabled:false, presetId:'', apiKey:''};
          // 确保 key 记忆 map 存在：byVendor 是新逻辑，byPreset 是历史兼容字段。
          if (!this.config[k].apiKeyByVendor || typeof this.config[k].apiKeyByVendor !== 'object') this.config[k].apiKeyByVendor = {};
          if (!this.config[k].apiKeyByPreset || typeof this.config[k].apiKeyByPreset !== 'object') this.config[k].apiKeyByPreset = {};
          if (typeof this.config[k].apiKey !== 'string') this.config[k].apiKey = '';
          // 记录初始 preset 到内存（不存 config.json，避免污染配置文件）
          this._lastPreset[k] = this.config[k].presetId;
          // 注意：GET 返回的顶层 apiKey 与 map 都是脱敏占位（含 ****）。
          // 仅当记忆 map 里有真实（非脱敏）值时，用它覆盖顶层；否则保留脱敏占位（用户重填时再存）。
          const pid = this.config[k].presetId;
          const remembered = this.rememberedApiKeyForPreset(k, pid);
          if (pid && remembered && !remembered.includes('****') && this.config[k].apiKey.includes('****')) {
            this.config[k].apiKey = remembered;
          }
        }
      } catch (e) {
        this._restoring = false;
        throw e;
      }
      // 配置已就绪，开启自动保存（下一帧后解除 _restoring，避免回填触发的 watch 事件）
      this.$nextTick(() => { this._loaded = true; this._restoring = false; });
    },
    async loadPresets() {
      const r = await fetch('/api/presets');
      if (!r.ok) throw new Error('加载模型预设失败 (' + r.status + ')');
      const data = await r.json();
      if (!data || data.error) throw new Error(data?.error || '加载模型预设失败');
      this.presets = data;
    },
    async loadStatus() {
      const r = await fetch('/api/status');
      if (!r.ok) throw new Error('加载状态失败 (' + r.status + ')');
      const data = await r.json();
      if (!data || data.error) throw new Error(data?.error || '加载状态失败');
      this.status = data;
    },
    async refreshStatus() {
      try { await this.loadStatus(); this.statusError = ''; }
      catch (e) { this.statusError = (e && e.message) ? e.message : String(e); }
    },
    async saveConfig() {
      // 载入未完成时禁止手动保存：此时 this.config 可能是残缺 stub，
      // PUT 会把磁盘真实配置覆盖清空（与 scheduleAutoSave 的护栏一致）。
      if (this.loadError) {
        this.saveErr = true; this.saveMsg = '✗ ' + (this.t.loadFailed || '配置未载入完成，请刷新页面重试');
        setTimeout(() => this.saveMsg = '', 4000);
        return;
      }
      this.saving = true; this.saveMsg = ''; this.saveErr = false;
      // 保存前：把每个模态当前顶层 apiKey 同步进 vendor/preset 记忆（避免未切换就改的 key 丢失）
      for (const k of ['image','video','audio']) {
        this.rememberCurrentApiKey(k);
      }
      try {
        const r = await fetch('/api/config', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(this.config) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || this.t.commitFailed);
        // 回填服务器返回的脱敏配置--置 _restoring 防止 watch 触发循环自动保存
        this._restoring = true;
        this.config = data.config; this.saveMsg = this.t.committed;
        this.$nextTick(() => { this._restoring = false; });
        await this.refreshStatus();
      } catch (e) { this.saveErr = true; this.saveMsg = '✗ ' + e.message; }
      finally { this.saving = false; setTimeout(() => this.saveMsg = '', 3000); }
    },
    /**
     * 自动保存（debounce）。监听 config 变化，停顿 800ms 后静默 PUT。
     * 让「勾选启用 / 切模型 / 改 Key」即时生效，无需手动点提交。
     * 静默：不设 saving、成功不弹 toast，仅失败提示。手动提交按钮保留作即时入口。
     */
    _autoSaveTimer: null,
    _restoring: false,
    _watchersInstalled: false,
    scheduleAutoSave() {
      // 首次载入回填阶段不触发；保存后从服务器回填配置时也不触发（防循环）；
      // 载入失败时也不触发（避免在 config 半就绪时把残缺数据覆盖写回磁盘）。
      if (!this._loaded || this._restoring || this.loadError) return;
      clearTimeout(this._autoSaveTimer);
      this._autoSaveTimer = setTimeout(() => this.silentSave(), 800);
    },
    async silentSave() {
      // 复用 saveConfig 的 key 记忆同步逻辑，但不设 saving 状态、成功不弹 toast
      for (const k of ['image','video','audio']) {
        this.rememberCurrentApiKey(k);
      }
      try {
        const r = await fetch('/api/config', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(this.config) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || this.t.commitFailed);
        // 回填服务器返回的脱敏配置——置 _restoring 防止 watch 触发循环自动保存
        this._restoring = true;
        this.config = data.config;
        this.$nextTick(() => { this._restoring = false; });
        await this.refreshStatus();
        // 极轻量的已保存提示，2s 自动消失
        this.saveMsg = this.t.autosaved || '✓ 已自动保存'; this.saveErr = false;
        setTimeout(() => { if (this.saveMsg === (this.t.autosaved || '✓ 已自动保存')) this.saveMsg = ''; }, 2000);
      } catch (e) {
        this.saveErr = true; this.saveMsg = '✗ 自动保存失败: ' + e.message;
        setTimeout(() => this.saveMsg = '', 4000);
      }
    },
    onPresetChange(key) {
      const mod = this.config[key];
      if (!mod.apiKeyByVendor) mod.apiKeyByVendor = {};
      if (!mod.apiKeyByPreset) mod.apiKeyByPreset = {};
      // 注意：onPresetChange 在 config[key].presetId 已被 dropdown 更新为新值后触发，
      // 故靠 _lastPreset[key] 记录切换前的 presetId 来保存旧 key。
      const newPresetId = mod.presetId;
      const oldPresetId = this._lastPreset[key];
      // 保存旧 preset/vendor 的 key（仅当非脱敏占位时，避免把 **** 存进 map）
      if (oldPresetId && oldPresetId !== newPresetId) {
        this.rememberCurrentApiKey(key, oldPresetId);
      }
      // 恢复新 preset 的 key：同一模态内优先按 vendor 共享，找不到再回退旧版 preset 记忆。
      // 若记忆值含 ****（服务器侧有 key），保留脱敏占位以免被 mergeConfig 当作清空；
      // 否则清空让用户填写）
      if (newPresetId !== oldPresetId) {
        const remembered = this.rememberedApiKeyForPreset(key, newPresetId);
        mod.apiKey = remembered || '';
      }
      this._lastPreset[key] = newPresetId;
      // 应用预设的 model/protocol（custom 不动）
      if (newPresetId === 'custom') return;
      const p = (this.presets[key] || []).find(x => x.id === newPresetId);
      if (p) { mod.model = p.model; mod.protocol = p.protocol; }
    },
    vendorKeyForPreset(key, presetId) {
      if (!presetId) return '';
      const p = (this.presets[key] || []).find(x => x.id === presetId);
      return p ? p.vendor : (presetId === 'custom' ? 'custom' : presetId);
    },
    rememberCurrentApiKey(key, presetIdOverride) {
      const mod = this.config[key];
      const presetId = presetIdOverride || mod?.presetId;
      if (!mod || !presetId || !mod.apiKey || mod.apiKey.includes('****')) return;
      if (!mod.apiKeyByVendor) mod.apiKeyByVendor = {};
      if (!mod.apiKeyByPreset) mod.apiKeyByPreset = {};
      const vendorKey = this.vendorKeyForPreset(key, presetId);
      if (vendorKey) mod.apiKeyByVendor[vendorKey] = mod.apiKey;
      mod.apiKeyByPreset[presetId] = mod.apiKey; // 兼容旧配置 / 旧引擎回退
    },
    rememberedApiKeyForPreset(key, presetId) {
      const mod = this.config[key];
      if (!mod || !presetId) return '';
      if (!mod.apiKeyByVendor) mod.apiKeyByVendor = {};
      if (!mod.apiKeyByPreset) mod.apiKeyByPreset = {};
      const vendorKey = this.vendorKeyForPreset(key, presetId);
      const byVendor = vendorKey ? mod.apiKeyByVendor[vendorKey] : '';
      if (byVendor) return byVendor;
      const byPreset = mod.apiKeyByPreset[presetId] || '';
      // 旧配置迁移：若旧 preset 记忆里有真实 key，顺手写入 vendor 记忆。
      if (byPreset && !byPreset.includes('****') && vendorKey) mod.apiKeyByVendor[vendorKey] = byPreset;
      return byPreset;
    },
    presetHelp(key) {
      // BaseURL 已有独立可编辑输入框展示，这里不再显示技术细节，返回空隐藏整行。
      return '';
    },
    // 当前 preset 的默认 BaseURL（custom 无默认值）
    presetBaseUrl(key) {
      const p = (this.presets[key] || []).find(x => x.id === this.config[key]?.presetId);
      return p?.baseUrl || '';
    },
    // 返回完整请求地址：baseUrl（用户值优先，否则 preset 默认）+ 协议×模态对应的主提交路径后缀。
    // 动态路径协议（无固定后缀）退化为只显示 baseUrl。
    displayEndpoint(key) {
      const mod = this.config[key];
      const base = (mod?.baseUrl?.trim() || this.presetBaseUrl(key) || '').replace(/\\/$/, '');
      const proto = mod?.protocol || this.presetProtocol(key) || '';
      const byModality = PROTOCOL_ENDPOINT_PATH[proto] || {};
      const suffix = byModality[key] || '';
      return base ? (base + suffix) : '';
    },
    // 当前 preset 的默认协议（custom 从 config 读）
    presetProtocol(key) {
      const p = (this.presets[key] || []).find(x => x.id === this.config[key]?.presetId);
      return p?.protocol || this.config[key]?.protocol || '';
    },
    // 返回当前协议的人类可读名（供展示，custom 下拉选项反查）
    protocolDisplayLabel(key) {
      const proto = this.presetProtocol(key);
      if (!proto) return '';
      const opts = (PROTOCOL_OPTIONS[this.lang] && PROTOCOL_OPTIONS[this.lang][key]) || [];
      const found = opts.find(o => o.value === proto);
      return found ? found.label : proto;
    },
    isReady(modality) { return this.status.modalities && this.status.modalities[modality]; },
    async runTest() {
      this.testing = true; this.testResult = null; this.testError = '';
      try {
        // 试用台用当前下拉选中的 presetId（含未保存的改动），让"改下拉→直接试"生效
        const m = this.test.modality;
        const body = { modality: m, prompt: this.test.prompt, apiKey: this.test.tempKey || undefined, presetId: this.config[m]?.presetId || undefined, size: this.test.size || undefined, numberOfImages: this.test.numberOfImages, duration: this.test.duration, task: this.test.task, voice: this.test.voice || undefined };
        const r = await fetch('/api/test', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || this.t.generationFailed);
        this.testResult = data;
      } catch (e) { this.testError = e.message; }
      finally { this.testing = false; }
    },
    async loadExport() {
      const r = await fetch('/api/export?agent=' + this.exportAgent);
      if (!r.ok) throw new Error('加载接入配置失败 (' + r.status + ')');
      const data = await r.json();
      if (!data || typeof data !== 'object' || data.error || !data.config) throw new Error(data?.error || '加载接入配置失败');
      this.exportData = data;
      this.exportText = JSON.stringify(this.exportData.config, null, 2);
    },
    async refreshExport() {
      try { await this.loadExport(); this.exportError = ''; }
      catch (e) { this.exportError = (e && e.message) ? e.message : String(e); }
    },
    async copyExport() {
      try { await navigator.clipboard.writeText(this.exportText); this.copied = true; setTimeout(() => this.copied = false, 2000); }
      catch (e) { const ta = document.createElement('textarea'); ta.value = this.exportText; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); this.copied = true; setTimeout(() => this.copied = false, 2000); }
    },
  };
}
</script>
</body>
</html>`
