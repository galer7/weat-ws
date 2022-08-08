export type FoodItem = {
  name: string;
  price: number;
};

export type SelectedFoodItem = {
  originalIndex: number;
} & FoodItem;

export type SelectedRestaurant = {
  name: string;
  items: SelectedFoodItem[];
  originalIndex: number;
};

export type GroupUserState = {
  isInviteAccepted: boolean;
  restaurants: SelectedRestaurant[];
};

export type ServerToClientEvents = {
  "server:first:render": (stringifiedState: string) => void;
  "server:invite:sent": (
    from: string,
    to: string,
    foodieGroupId: string
  ) => void;
  "server:state:updated": (stringifiedState: string, name: string) => void;
};

export type ClientToServerEvents = {
  "user:first:render": (foodieGroupId: string) => void;
  "user:invite:sent": (
    from: string,
    to: string,
    foodieGroupId: string,
    fromUserState: GroupUserState
  ) => void;
  "user:invite:response": (
    from: string,
    to: string,
    foodieGroupId?: GroupUserState
  ) => void;
  "user:state:updated": (
    name: string,
    foodieGroupId: string,
    userState?: GroupUserState
  ) => void;
};
