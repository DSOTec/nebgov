import toast from "react-hot-toast";

const MAX_VISIBLE = 3;
const slots = Array.from({ length: MAX_VISIBLE }, (_, i) => ({
  id: `toast-slot-${i}`,
  occupied: false,
}));
let nextSlot = 0;

function nextFreeSlot(): number {
  for (let i = 0; i < MAX_VISIBLE; i++) {
    if (!slots[nextSlot].occupied) return nextSlot;
    nextSlot = (nextSlot + 1) % MAX_VISIBLE;
  }
  const evict = nextSlot;
  nextSlot = (nextSlot + 1) % MAX_VISIBLE;
  return evict;
}

export function showToast(
  message: string,
  type: "success" | "error" = "success",
  duration?: number,
) {
  const slotIdx = nextFreeSlot();
  const slot = slots[slotIdx];
  const id = slot.id;

  if (slot.occupied) {
    toast.dismiss(id);
  }

  slot.occupied = true;
  const dur = duration ?? (type === "error" ? 6000 : 4000);
  const opts = { id, duration: dur };

  if (type === "error") {
    toast.error(message, opts);
  } else {
    toast.success(message, opts);
  }

  setTimeout(() => {
    slot.occupied = false;
  }, dur + 300);
}
