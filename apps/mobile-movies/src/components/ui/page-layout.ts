/** A page's side gutter: 20 on an iPhone, 32 in an iPad's portrait window, 48 in landscape. */
export const GUTTER = "px-5 regular:px-8 wide:px-12";

/**
 * On an iPad, the 600-point readable column at the gutter's left edge, for rows and Cast & Crew;
 * on an iPhone, the full width inside `px-5`.
 */
export const READABLE_COLUMN = "px-5 regular:mx-8 regular:max-w-readable regular:px-0 wide:mx-12";

/**
 * For a detail page's scrolling content (Watch Together, a room, a download, About): the full width
 * inside `px-5` on an iPhone, and on an iPad the readable column centered in the window, so its
 * 16:9 artwork stays 600 wide and the actions under it stay on screen.
 */
export const CENTERED_COLUMN =
  "regular:w-full regular:max-w-readable regular:self-center regular:px-0";
