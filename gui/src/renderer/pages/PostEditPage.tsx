import { PostEditWorkspace } from "../features/post-edit/PostEditWorkspace";
import { usePostEditController } from "../features/post-edit/usePostEditController";

export function PostEditPage() {
  return <PostEditWorkspace controller={usePostEditController()} />;
}
