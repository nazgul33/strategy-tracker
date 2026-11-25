// Placeholder until the VR fills panel lands (Task 7).
export interface VrPanelProps {
  runId: number;
  costPpm: number;
  today: string;
  onChanged: () => void;
}

export function VrFillsPanel({ runId }: VrPanelProps) {
  return <div data-testid="vrFillsPanel" data-run-id={runId} />;
}
