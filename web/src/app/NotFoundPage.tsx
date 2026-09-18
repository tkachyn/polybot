import { ButtonLink } from "../components/Button";
import { EmptyState } from "../components/Feedback";
import { Page } from "../components/Page";

export function NotFoundPage() {
  return (
    <Page title="Not found">
      <EmptyState
        title="Page not found"
        description="That address doesn’t match any screen."
        action={
          <ButtonLink to="/fights" variant="ghost">
            Back to fights
          </ButtonLink>
        }
      />
    </Page>
  );
}
