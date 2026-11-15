import { usePaseo, useSettings, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Loading, SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { boardLayout } from "../shared/layout";
import { MODEL_NAMES, SUMMARY_MODELS, type SummaryModel } from "../shared/summary";
import { messages } from "./messages";

/** Summary models whose Paseo provider is enabled and ready on the daemon host, in preference order. */
export function useReadyModels(): SummaryModel[] {
  const paseo = usePaseo();
  const providers = useQuery({ queryKey: ["agent-board", "providers"], queryFn: () => paseo.providers.snapshot() });
  return SUMMARY_MODELS.filter((id) =>
    providers.data?.entries.some((entry) => entry.provider === id && entry.enabled !== false && entry.status === "ready"),
  );
}

/** The saved model when its provider is ready, else the first ready one; null while none is. */
export const pickModel = (saved: SummaryModel | null, ready: SummaryModel[]): SummaryModel | null =>
  saved !== null && ready.includes(saved) ? saved : (ready[0] ?? null);

/** The plugin's page in Paseo settings: which model writes the board's summaries. */
export function SummarySettings(_: PluginSurfaceProps) {
  const { t } = useTranslation(messages);
  const settings = useSettings(boardLayout);
  const ready = useReadyModels();
  if (settings.status !== "ready") return <Loading />;
  const choose = (model: SummaryModel) =>
    void settings.save({ ...settings.values, model }, settings.revision).then((ok) => {
      if (!ok) void settings.reload();
    });
  return (
    <SettingsSection title={t("settings.summaries")} info={t("settings.info")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.model")}
          hint={t("settings.modelHint")}
          error={settings.saveError}
          value={pickModel(settings.values.model, ready) ?? settings.values.model ?? SUMMARY_MODELS[0]}
          options={SUMMARY_MODELS.map((id) => ({
            value: id,
            label: ready.includes(id) ? MODEL_NAMES[id] : t("settings.notReady", { name: MODEL_NAMES[id] }),
          }))}
          onValueChange={choose}
          disabled={settings.saving}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
