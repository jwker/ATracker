import { StrictMode, Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import './receipt.css';
import { App } from './App.tsx';

/**
 * 顶层错误边界。
 *
 * 没有它的时候，渲染过程中抛出的异常会让整页变成空白，用户只看到一片白，
 * 不知道是出错了还是没数据。这里把错误显示出来，至少能看出问题在哪。
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('页面渲染出错', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <div className="crashcard">
          <h1>页面出错了</h1>
          <p className="errmsg">{error.message}</p>
          <p className="muted">刷新一下试试。数据都在本地库里，不会丢。</p>
          <button type="button" className="ghost" onClick={() => location.reload()}>重新加载</button>
        </div>
      </div>
    );
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 挂载点');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
