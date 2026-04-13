import {
  type InteractiveRequestId,
  type InteractiveRequestResolution,
} from "@forgetools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: InteractiveRequestId;
  isResponding: boolean;
  onRespondToInteractiveRequest: (
    requestId: InteractiveRequestId,
    resolution: InteractiveRequestResolution,
  ) => Promise<void>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  onRespondToInteractiveRequest,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={isResponding}
        onClick={() => void onRespondToInteractiveRequest(requestId, { decision: "cancel" })}
      >
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={() => void onRespondToInteractiveRequest(requestId, { decision: "decline" })}
      >
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={isResponding}
        onClick={() =>
          void onRespondToInteractiveRequest(requestId, { decision: "acceptForSession" })
        }
      >
        Always allow this session
      </Button>
      <Button
        size="sm"
        variant="default"
        disabled={isResponding}
        onClick={() => void onRespondToInteractiveRequest(requestId, { decision: "accept" })}
      >
        Approve once
      </Button>
    </>
  );
});
