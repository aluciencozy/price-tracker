import type { Alerts } from '../data/types';
import { Checkbox } from './ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from './ui/field';
import { Input } from './ui/input';
export default function PreferencesFields({
  target,
  onTarget,
  enabled,
  onEnabled,
  alerts,
  onAlerts,
  invalid,
}: {
  target: string;
  onTarget: (value: string) => void;
  enabled: boolean;
  onEnabled: (value: boolean) => void;
  alerts: Alerts;
  onAlerts: (value: Alerts) => void;
  invalid?: boolean;
}) {
  return (
    <FieldGroup>
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor="target">Target price (USD)</FieldLabel>
        <Input
          id="target"
          inputMode="decimal"
          value={target}
          onChange={(event) => onTarget(event.target.value)}
          aria-invalid={invalid}
          aria-describedby="target-help"
          placeholder="4.99"
        />
        <FieldDescription id="target-help">
          At or below this price qualifies. $0.00 is a valid target.
        </FieldDescription>
      </Field>
      <FieldSet>
        <FieldLegend variant="label">Alerts for this game</FieldLegend>
        <FieldDescription>
          Sample preferences only. Email and Android push are not connected.
        </FieldDescription>
        <FieldGroup className="gap-3">
          <Field orientation="horizontal">
            <Checkbox
              id="email-alert"
              checked={alerts.email}
              onCheckedChange={(value) =>
                onAlerts({ ...alerts, email: value === true })
              }
            />
            <FieldLabel htmlFor="email-alert">Email</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id="push-alert"
              checked={alerts.push}
              onCheckedChange={(value) =>
                onAlerts({ ...alerts, push: value === true })
              }
              aria-describedby="push-help"
            />
            <FieldLabel htmlFor="push-alert">Android push</FieldLabel>
          </Field>
        </FieldGroup>
        <FieldDescription id="push-help">
          Needs an opted-in, registered Android device. No device is connected
          here. This is not browser push.
        </FieldDescription>
      </FieldSet>
      <Field orientation="horizontal">
        <Checkbox
          id="tracker-enabled"
          checked={enabled}
          onCheckedChange={(value) => onEnabled(value === true)}
        />
        <FieldLabel htmlFor="tracker-enabled">Tracking enabled</FieldLabel>
      </Field>
    </FieldGroup>
  );
}
