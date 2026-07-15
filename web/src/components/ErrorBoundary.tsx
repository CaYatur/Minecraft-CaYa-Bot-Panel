import { Component, type ReactNode } from "react";
import { OctagonAlert } from "lucide-react";
import { translate } from "../i18n";
import { useAppStore } from "../stores/useAppStore";

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
      const locale = useAppStore.getState().locale;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <OctagonAlert className="h-10 w-10 text-red-400" />
          <h1 className="text-lg font-semibold text-red-300">{translate(locale, "errorBoundary.title")}</h1>
          <p className="mono max-w-xl text-xs break-all text-zinc-500">{this.state.error.message}</p>
          <button
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            {translate(locale, "errorBoundary.reload")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
