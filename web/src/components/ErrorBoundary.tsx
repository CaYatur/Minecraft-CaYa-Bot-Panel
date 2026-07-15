import { Component, type ReactNode } from "react";

/**
 * Tek bir sayfa/bileşen hatası tüm paneli karartmasın (İ4'ün panel tarafı).
 * Hata mesajı gösterilir; kullanıcı sayfayı tazeleyebilir.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <span className="text-4xl">💥</span>
          <h1 className="text-lg font-semibold text-red-300">Panelde bir hata oluştu</h1>
          <p className="mono max-w-xl text-xs break-all text-zinc-500">{this.state.error.message}</p>
          <button
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Sayfayı Yenile
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
