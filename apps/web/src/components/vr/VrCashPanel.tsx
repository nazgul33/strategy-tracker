// Placeholder until the VR cash panel lands (Task 7).
import type { VrPanelProps } from './VrFillsPanel';

export function VrCashPanel({ runId }: VrPanelProps) {
  return <div data-testid="vrCashPanel" data-run-id={runId} />;
}
