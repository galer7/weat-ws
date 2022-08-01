import { Server, Socket } from "socket.io";
import { prisma } from "./prisma/client";
import superjson from "superjson";
import { FoodieGroup } from "@prisma/client";
const io = new Server(3001, {
  cors: {
    origin: "*",
  },
});

const persistStateChangeAsync = async (foodieGroupMap, foodieGroupId) => {
  console.log({ foodieGroupMap, foodieGroupId });
  await prisma.foodieGroup.update({
    where: { id: foodieGroupId },
    data: { foodieGroupState: superjson.stringify(foodieGroupMap) },
  });
};

const m: Map<string, Map<string, Array<object>>> = new Map();

(async () => {
  const allFoodieGroups = await prisma.foodieGroup.findMany();
  allFoodieGroups.forEach(
    ({ id, foodieGroupState: stringifiedFoodieGroupState }: FoodieGroup) => {
      if (!stringifiedFoodieGroupState) return;
      m.set(id, superjson.parse(stringifiedFoodieGroupState));
    }
  );
  console.log(m);

  io.on("connection", (socket: Socket) => {
    socket.on("user:first:render", (foodieGroupId) => {
      const foodieGroupMap: Map<string, object> | undefined =
        m.get(foodieGroupId);

      console.log({ foodieGroupMap });

      socket.join(foodieGroupId);
      socket.emit("server:first:render", superjson.stringify(foodieGroupMap));
    });

    socket.on(
      "user:invite:sent",
      async (from, to, foodieGroupId, fromUserState) => {
        // create room on first group invite sent
        console.log("received user:invite:sent", {
          from,
          to,
          foodieGroupId,
          fromUserState,
        });

        // send to all users ever unfortunately
        io.emit("server:invite:sent", from, to, foodieGroupId);
        socket.join(foodieGroupId);

        // if it is the first invite, the sender sends its user state also
        if (!m.has(foodieGroupId)) {
          m.set(
            foodieGroupId,
            new Map([
              [from, fromUserState],
              [to, []],
            ])
          );
        } else {
          m.get(foodieGroupId).set(to, []);
        }
        await persistStateChangeAsync(m.get(foodieGroupId), foodieGroupId);

        console.log("map after invite sent", m);
      }
    );

    socket.on(
      "user:invite:accepted",
      async (name, foodieGroupId, userState) => {
        // add socket which accepted the invite to the room
        socket.join(foodieGroupId);

        // update group state so that we can render RT updates
        const foodieGroupMap: Map<string, object> | undefined =
          m.get(foodieGroupId);
        if (!foodieGroupMap) return;
        foodieGroupMap.set(name, userState);
        await persistStateChangeAsync(foodieGroupMap, foodieGroupId);

        // TODO: Create here the foodieGroup in the DB, not from the next.js

        foodieGroupMap.forEach((userState, name) => {
          io.to(foodieGroupId).emit(
            "server:state:updated",
            superjson.stringify(userState),
            name
          );
        });
      }
    );

    socket.on(
      "user:state:updated",
      async (name, foodieGroupId, userState: object[] | undefined) => {
        console.log("received user:state:updated event", {
          name,
          foodieGroupId,
          userState,
        });

        console.log(m);
        // update group state so that we can render RT updates
        if (!m.get(foodieGroupId)) {
          console.log(`user ${name} does not exist on FG ${foodieGroupId}`);
          // TODO: remove this, it should theoretically exist already
          m.set(foodieGroupId, new Map());
        }
        const foodieGroupMap: Map<string, object> | undefined =
          m.get(foodieGroupId);

        let isOnlyOneLeft = false;
        // if userState comes undefined, it means it either left the group or signed-out
        if (!userState) {
          foodieGroupMap.delete(name);
          console.log("after delete name", { foodieGroupMap });

          // if there is only one more member in the foodieGroup after another user left, delete the foodieGroup from the in-memory map
          if (foodieGroupMap.size === 1) {
            isOnlyOneLeft = true;
            m.delete(foodieGroupId);
            console.log("after delete foodiegroup", { m });
          }
        } else {
          foodieGroupMap.set(name, userState);
        }

        if (!isOnlyOneLeft) {
          // the foodieGroup from the DB is deleted through TRPC from Next.js app in this case
          await persistStateChangeAsync(foodieGroupMap, foodieGroupId);
        }

        console.log(m);

        console.log("emit server:state:updated", [
          superjson.stringify(foodieGroupMap.get(name)),
          name,
        ]);

        io.to(foodieGroupId).emit(
          "server:state:updated",
          superjson.stringify(userState),
          name
        );
      }
    );
  });

  console.log("registered all handlers!");
})();
