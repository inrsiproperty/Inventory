// TEST-ONLY loose React typings (the real @types/react is used by `npm run typecheck`).
declare module 'react' {
  export type ReactNode = any;
  export type ButtonHTMLAttributes<T> = { [k: string]: any };
  export function useState<T>(init: T | (() => T)): [T, (v: T | ((p: T) => T)) => void];
  export function useState<T = undefined>(): [T | undefined, (v: T | undefined | ((p: T | undefined) => T | undefined)) => void];
  export function useEffect(fn: () => void | (() => void), deps?: unknown[]): void;
  export function useRef<T>(v: T): { current: T };
  export function useRef<T>(v: T | null): { current: T | null };
  export function useMemo<T>(fn: () => T, deps: unknown[]): T;
  export function useCallback<T extends (...a: any[]) => any>(fn: T, deps: unknown[]): T;
  export function useContext<T>(c: Context<T>): T;
  export interface Context<T> { Provider: any; _v?: T }
  export function createContext<T>(v: T): Context<T>;
  export const StrictMode: any;
}
declare module 'react/jsx-runtime' { export const jsx: any; export const jsxs: any; export const Fragment: any; }
declare module 'react-dom/client' { export function createRoot(el: Element): { render(n: any): void }; }
declare namespace JSX { interface IntrinsicElements { [k: string]: any } interface Element {} interface IntrinsicAttributes { key?: any } }
interface ImportMetaEnv { VITE_MSAL_CLIENT_ID?: string; BASE_URL: string }
interface ImportMeta { env: ImportMetaEnv }
declare module "*.css";
