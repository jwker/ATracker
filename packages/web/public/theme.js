// 在样式生效前把明暗模式设好。
//
// 应用真正保存的偏好是 localStorage 里的 atracker-mode（或者 URL 上的
// ?theme=），index.html 里写死的 data-mode="light" 只是首屏的兜底。
// 这个脚本放在 head 里同步执行，CSS 第一次绘制时模式就已经是对的，
// 不会先闪一下白底再翻成暗色。
(function () {
  var mode = 'light';
  try {
    var p = new URLSearchParams(location.search).get('theme');
    if (p === 'dark' || p === 'light') {
      mode = p;
    } else {
      var saved = localStorage.getItem('atracker-mode');
      if (saved === 'dark' || saved === 'light') mode = saved;
    }
  } catch (e) {
    // localStorage 不可用（隐私模式之类），用默认的亮色
  }
  document.documentElement.dataset.mode = mode;
})();
