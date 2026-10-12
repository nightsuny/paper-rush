import './ui/styles.css';
import { Game } from './game/Game';

/**
 * 入口。
 *
 * 只做三件事：拿到画布、显示加载状态、启动 Game。
 * 所有游戏逻辑都在 game/ 里，这里保持极薄，方便测试直接使用 Game。
 */

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement | null;
  const uiRoot = document.getElementById('ui');
  const boot = document.getElementById('boot');
  if (!canvas || !uiRoot) {
    throw new Error('页面缺少 #view 画布或 #ui 容器');
  }

  try {
    const game = await Game.create(canvas, uiRoot, { quality: 'high', showDebug: false });
    // 暴露到全局，方便在浏览器控制台里做诊断与自动化验证
    (window as unknown as { paperRush: Game }).paperRush = game;
    boot?.classList.add('hide');
    window.setTimeout(() => boot?.remove(), 500);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (boot) {
      boot.textContent = `启动失败：${message}`;
      boot.style.color = '#a12c23';
    }
    throw error;
  }
}

void main();
