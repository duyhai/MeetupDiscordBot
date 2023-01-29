export interface GetUserInfoResponse {
  self: {
    gender: string;
    id: string;
    memberships: {
      edges: {
        node: {
          id: string;
          name: string;
        };
      }[];
    };
    name: string;
  };
}
