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

  if (error) return <p className="p-5 text-sm text-red-500">{error}</p>;
  if (!packages) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-sm text-neutral-400">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
      </div>
    );
  }

  return (
    <div className="space-y-6 p-5">
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-neutral-700">
          <Package className="h-4 w-4 text-orange-500" />
          已安装 Package
        </h3>
        {packages.length === 0 ? (
          <p className="rounded-lg bg-neutral-50 px-3 py-4 text-center text-sm text-neutral-400">
            未配置 package
          </p>
        ) : (
          <ul className="space-y-1.5">
            {packages.map((p) => (
              <li
                key={p}
                className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-700"
              >
                <Package className="h-3.5 w-3.5 shrink-0 text-orange-400" />
                <span className="truncate font-mono text-xs" title={p}>{p}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-neutral-700">
          <Layers className="h-4 w-4 text-orange-500" />
          Provider (models.json)
        </h3>
        {providers && providers.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {providers.map((p) => (
              <span key={p} className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs text-neutral-600">
                {p}
              </span>
            ))}
          </div>
        ) : (
          <p className="rounded-lg bg-neutral-50 px-3 py-4 text-center text-sm text-neutral-400">
            未读取到 provider 配置
          </p>
        )}
      </section>
    </div>
  );
}
