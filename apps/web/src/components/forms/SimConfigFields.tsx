// The editable simulation parameters as one input grid, shared by the new-sim
// form and the draft panel so both show the same fields with the same live
// validation. The ticker is deliberately not here: it is the sim's identity.
import { simFieldFlags } from '../../simconfig';
import type { SimConfigForm } from '../../simconfig';
import { useT } from '../../i18n';
import { Field, Input } from '../ui';

export function SimConfigFields({
  form,
  onChange,
  disabled = false,
  costNote,
}: {
  form: SimConfigForm;
  onChange: (field: keyof SimConfigForm, value: string) => void;
  disabled?: boolean;
  costNote?: string;
}) {
  const t = useT();
  const flags = simFieldFlags(form);
  const bind = (field: keyof SimConfigForm) => ({
    value: form[field],
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(field, e.target.value),
  });

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Field label={t('simStart')}>
        <Input data-testid="simFromInput" type="date" required {...bind('from')} />
      </Field>
      <Field label={t('simEnd')}>
        <Input data-testid="simToInput" type="date" required {...bind('to')} />
      </Field>
      <Field label={t('simPool')}>
        <Input data-testid="simPoolInput" inputMode="decimal" placeholder="100000" required {...bind('pool')} />
      </Field>
      <Field label={t('simCostPpm')} hint={t('runForm.costHint')}>
        <Input data-testid="costInput" inputMode="decimal" placeholder="0.070" required invalid={flags.cost} {...bind('cost')} />
        {costNote !== undefined && (
          <span data-testid="costDefaultFailed" role="status" className="mt-1 block text-[11px] text-warning">
            {costNote}
          </span>
        )}
      </Field>
      <Field label={t('simForm.buyGapLabel')}>
        <Input data-testid="buyGapInput" inputMode="decimal" placeholder="0" invalid={flags.buyGap} {...bind('buyGap')} />
      </Field>
      <Field label={t('simForm.sellGapLabel')}>
        <Input data-testid="sellGapInput" inputMode="decimal" placeholder="0" invalid={flags.sellGap} {...bind('sellGap')} />
      </Field>
      <Field label={t('runForm.cutLossLabel')} hint={t('runForm.cutLossHint')}>
        <Input data-testid="cutLossInput" inputMode="decimal" placeholder="0" invalid={flags.cutLoss} {...bind('cutLoss')} />
      </Field>
      <Field label={t('runBucketCount')}>
        <Input data-testid="bucketCountInput" inputMode="numeric" {...bind('bucketCount')} />
      </Field>
      <Field label={t('simMaxAge')}>
        <Input data-testid="maxAgeInput" inputMode="numeric" {...bind('maxAge')} />
      </Field>
    </div>
  );
}
