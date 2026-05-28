import { useEffect } from 'react';
import './SplashScreen.scss';

interface SplashScreenProps {
  onFinish: () => void;
  fadeOut?: boolean;
}

const FADE_OUT_DURATION = 400;

export function SplashScreen({ onFinish, fadeOut = false }: SplashScreenProps) {
  useEffect(() => {
    if (!fadeOut) return;
    const finishTimer = setTimeout(() => {
      onFinish();
    }, FADE_OUT_DURATION);

    return () => {
      clearTimeout(finishTimer);
    };
  }, [fadeOut, onFinish]);

  return (
    <div className={`splash-screen ${fadeOut ? 'fade-out' : ''}`}>
      <div className="splash-content">
        <div className="splash-logo splash-logo-mark" aria-hidden="true">CR</div>
        <h1 className="splash-title">OpenStar Admin</h1>
        <p className="splash-subtitle">正在连接账号池控制台</p>
        <div className="splash-loader">
          <div className="splash-loader-bar" />
        </div>
      </div>
    </div>
  );
}
