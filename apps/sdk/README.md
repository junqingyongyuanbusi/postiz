# Postiz NodeJS SDK

This is the NodeJS SDK for [Postiz](https://postiz.com).

You can start by installing the package:

```bash
pnpm add @postiz/node
```

## Usage
```typescript
import Postiz from '@postiz/node';
const postiz = new Postiz('your api key', 'your self-hosted instance (optional)');
```

The available methods are:
- `post(posts: CreatePostDto)` - Schedule a post to Postiz
- `postList(filters: GetPostsDto)` - Get a list of posts
- `upload(file: Buffer, extension: string)` - Upload a file to Postiz
- `integrations()` - Get a list of connected channels
- `deletePost(id: string)` - Delete a post by ID

Alternatively you can use the SDK with curl, check the [Postiz API documentation](https://docs.postiz.com/public-api) for more information.

## Self-hosted fork extension: saveAction

This section describes an extension in this self-hosted fork, not the official
upstream API. Point the SDK at your fork's instance to use it.

`CreatePostDto` accepts an optional `saveAction`: `draft`, `schedule`, `now`,
`update`, or `pass`. The existing `type` values remain `draft`, `schedule`, `now`,
and `update`; `pass` is not a valid `type`.

- `saveAction: "pass"` means reject (not approved), and requires `type: "draft"`.
  This first phase supports new drafts and existing untouched `DRAFT` posts only,
  with no `releaseId`, `releaseURL`, or `error` and no Temporal workflow record.
  Existing `QUEUE`, `ERROR`, and `PUBLISHED` posts return a conflict for `pass`;
  the frontend does not show the reject action for those states.
- `saveAction: "update"` is valid with `type: "schedule"` or `type: "update"`.
  The bottom-right **Update** button still sends `type: "schedule"` with
  `saveAction: "update"`.
- Every other explicit `saveAction` must equal `type`.
- When `saveAction` is omitted, the server uses the validated `type` as the action.
  Historical rows return `saveAction: null`; no historical action is inferred.

`saveAction` records the save action, not the publishing state. State values
remain `QUEUE`, `PUBLISHED`, `ERROR`, and `DRAFT`. `creationMethod` is unchanged.
This field is not a historical audit trail and does not store a rejection reason.

### Create a rejected draft

This is a complete JSON body for `POST /public/v1/posts` (or `postiz.post(body)`).
Replace the integration, uploaded image, and existing tag placeholders with values
from your instance. Content must be nonempty. The server infers provider settings,
so `settings` is omitted.

```json
{
  "type": "draft",
  "saveAction": "pass",
  "shortLink": false,
  "date": "2026-12-01T10:00:00.000Z",
  "tags": [
    {
      "value": "YOUR_EXISTING_TAG_ID",
      "label": "Review"
    }
  ],
  "posts": [
    {
      "integration": {
        "id": "YOUR_INTEGRATION_ID"
      },
      "value": [
        {
          "content": "This draft was not approved for publication.",
          "image": [
            {
              "id": "YOUR_UPLOADED_IMAGE_ID",
              "path": "https://your-instance.example/uploads/review-image.png"
            }
          ]
        }
      ]
    }
  ]
}
```

For an update, the following is a fragment only, not a complete request. Keep all
other required fields and the existing post identifiers in the full request:

```json
{
  "type": "schedule",
  "saveAction": "update"
}
```

### Responses and limits

`POST /public/v1/posts` keeps its existing `{postId, integration}[]` response
unchanged. `GET /public/v1/posts?startDate=...&endDate=...` keeps the existing
`{posts: []}` wrapper and adds `saveAction` to each post, including `null` for
historical rows. This is metadata exposed through the authenticated public API
only; it does not change publishing state.

The authenticated API supports this extension. MCP tools, webhook payloads, and
anonymous previews are unchanged.

For an existing eligible draft, the server requires Temporal to be available and
strictly confirms the absence of any workflow record. Unavailable Temporal or
uncertain workflow history returns a conflict without saving.

This phase does not cancel scheduled jobs. Rejecting existing queued posts is
deferred to a separate versioned cancellation protocol. A conflict does not mean
platform content was withdrawn, and this extension performs no platform retraction.

Deployment requires a reviewed schema change for the additive nullable field and
a successful database dump before applying it. Generate the Prisma client on the
server only; existing rows remain `null` rather than receiving a fabricated history.
