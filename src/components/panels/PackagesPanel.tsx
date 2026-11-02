import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Package, Loader2, Layers } from "lucide-react";

// Package 面板: settings.json 里配置的 pi packages (只读)
export function PackagesPanel() {
  const [packages, setPackages] = useState<string[] | null>(null);
  const [providers, setProviders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ packages: string[]; providers: string[] }>("list_skills_and_packages")
      .then((v) => {
        setPackages(v.packages || []);
        setProviders(v.providers || []);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="p-5 text-body text-err">{error}</p>;
  if (!packages) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-body text-fg-4">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
      </div>
    );
  }

  return (
    <div className="space-y-6 p-5">
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-lead font-semibold text-fg">
          <Package className="h-4 w-4 text-fg-3" />
          已安装 Package
        </h3>
        {packages.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-2 px-3 py-6 text-center text-body text-fg-4">
            未配置 package
          </p>
        ) : (
          <ul className="space-y-2">
            {packages.map((p) => (
              <li
                key={p}
                className="flex h-10 items-center gap-2 rounded-lg border border-line bg-card px-3 text-body text-fg-2 shadow-sm"
              >
                <Package className="h-4 w-4 shrink-0 text-fg-3" />
                <span className="truncate font-mono text-label" title={p}>{p}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-3 flex items-center gap-2 text-lead font-semibold text-fg">
          <Layers className="h-4 w-4 text-fg-3" />
          Provider (models.json)
        </h3>
        {providers && providers.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {providers.map((p) => (
              <span key={p} className="inline-flex h-6 items-center rounded-full bg-well px-3 text-label text-fg-2 shadow-[inset_0_0_0_1px_var(--line)]">
                {p}
              </span>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-line-2 px-3 py-6 text-center text-body text-fg-4">
            未读取到 provider 配置
          </p>
        )}
      </section>
    </div>
  );
}
