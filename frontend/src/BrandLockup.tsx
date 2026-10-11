import fabrykaMark from "./assets/fabryka-mark-ink.svg";
import "./brand-lockup.css";

export function BrandLockup() {
  return (
    <span className="brand-lockup">
      <img src={fabrykaMark} alt="" width="64" height="64" />
      <span className="brand-lockup-wordmark">
        fabryka<span> / track</span>
      </span>
    </span>
  );
}
