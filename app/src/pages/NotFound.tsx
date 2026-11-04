import { Link } from "react-router-dom";
import { BullMark } from "../components/brand/BullMark";

export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-32 text-center">
      <BullMark size={96} />
      <h1 className="text-2xl font-semibold">This page wandered off the trading floor</h1>
      <Link to="/" className="btn-gold h-10 px-5">
        Back to the board
      </Link>
    </div>
  );
}
