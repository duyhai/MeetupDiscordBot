export interface GetUserInfoResponse {
  self: {
    id: string;
    memberships: {
      edges: {
        node: {
          id: string;
          name: string;
        };
      };
    };
    name: string;
  };
}
