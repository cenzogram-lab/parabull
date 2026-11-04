/** Routes that show the floating "Start a coin" button on mobile: the board and the screener. */
export const showsCreateFab = (pathname: string) => pathname === "/" || pathname === "/board" || pathname === "/explore";
