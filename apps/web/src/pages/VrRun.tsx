// Placeholder until the VR run page lands (Task 6). The root element keeps its test id and run id in every state.
import { Spinner } from '../components/ui';

export function VrRunPage({ id }: { id: number }) {
  return (
    <div data-testid="vr-run-page" data-run-id={id}>
      <Spinner />
    </div>
  );
}
