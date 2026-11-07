import arrowsRotate from '@iconify-icons/fa7-solid/arrows-rotate';
import ban from '@iconify-icons/fa7-solid/ban';
import bars from '@iconify-icons/fa7-solid/bars';
import bell from '@iconify-icons/fa7-solid/bell';
import book from '@iconify-icons/fa7-solid/book';
import bookBookmark from '@iconify-icons/fa7-solid/book-bookmark';
import bookOpen from '@iconify-icons/fa7-solid/book-open';
import brain from '@iconify-icons/fa7-solid/brain';
import bug from '@iconify-icons/fa7-solid/bug';
import clock from '@iconify-icons/fa7-solid/clock';
import clockRotateLeft from '@iconify-icons/fa7-solid/clock-rotate-left';
import codeMerge from '@iconify-icons/fa7-solid/code-merge';
import commentDots from '@iconify-icons/fa7-solid/comment-dots';
import comments from '@iconify-icons/fa7-solid/comments';
import copy from '@iconify-icons/fa7-solid/copy';
import database from '@iconify-icons/fa7-solid/database';
import desktop from '@iconify-icons/fa7-solid/desktop';
import download from '@iconify-icons/fa7-solid/download';
import eye from '@iconify-icons/fa7-solid/eye';
import eyeSlash from '@iconify-icons/fa7-solid/eye-slash';
import gear from '@iconify-icons/fa7-solid/gear';
import gripLines from '@iconify-icons/fa7-solid/grip-lines';
import images from '@iconify-icons/fa7-solid/images';
import key from '@iconify-icons/fa7-solid/key';
import language from '@iconify-icons/fa7-solid/language';
import lightbulb from '@iconify-icons/fa7-solid/lightbulb';
import moon from '@iconify-icons/fa7-solid/moon';
import paperPlane from '@iconify-icons/fa7-solid/paper-plane';
import pen from '@iconify-icons/fa7-solid/pen';
import rightFromBracket from '@iconify-icons/fa7-solid/right-from-bracket';
import rotateLeft from '@iconify-icons/fa7-solid/rotate-left';
import scroll from '@iconify-icons/fa7-solid/scroll';
import sliders from '@iconify-icons/fa7-solid/sliders';
import sun from '@iconify-icons/fa7-solid/sun';
import tableColumns from '@iconify-icons/fa7-solid/table-columns';
import userGear from '@iconify-icons/fa7-solid/user-gear';
import waveSquare from '@iconify-icons/fa7-solid/wave-square';
import wandMagicSparkles from '@iconify-icons/fa7-solid/wand-magic-sparkles';
import { type BuiltinIconProps, Icon, type IconData } from '@tuuject/koi-react/icons';

// Business icons from Font Awesome Free Solid, rendered by Koi's Icon in currentColor like Koi's own. Koi's
// built-ins (close, check, chevrons, search, plus, trash, upload, external, info / warning / error) are imported
// from `@tuuject/koi-react/icons` directly; only what Koi doesn't ship lives here.
function icon(data: IconData) {
  return (props: BuiltinIconProps) => <Icon icon={data} {...props} />;
}

// Navigation groups.
export const MonitorIcon = icon(desktop);
export const ActivityIcon = icon(clockRotateLeft);
export const DatabaseIcon = icon(database);
export const MediaIcon = icon(images);
export const SlidersIcon = icon(sliders);
export const TelegramIcon = icon(paperPlane);
export const SettingsIcon = icon(gear);

// Shell controls.
export const MenuIcon = icon(bars);
// Free Solid has no sidebar glyph; two columns reads closest (as in the Koi admin template).
export const PanelLeftIcon = icon(tableColumns);
// Horizontal bars: "put the navigation in a row".
export const RowsIcon = icon(gripLines);
export const SunIcon = icon(sun);
export const MoonIcon = icon(moon);
export const LanguageIcon = icon(language);
export const LogoutIcon = icon(rightFromBracket);
export const UserSettingsIcon = icon(userGear);

// Actions.
export const EditIcon = icon(pen);
export const CancelIcon = icon(ban);
export const RefreshIcon = icon(arrowsRotate);
export const ResetIcon = icon(rotateLeft);
export const DownloadIcon = icon(download);
export const CopyIcon = icon(copy);
export const EyeIcon = icon(eye);
export const EyeOffIcon = icon(eyeSlash);
export const MergeIcon = icon(codeMerge);
export const SendIcon = icon(paperPlane);

// Content markers.
export const ClockIcon = icon(clock);
export const AlarmIcon = icon(bell);
export const BrainIcon = icon(brain);
export const BookIcon = icon(book);
export const ScrollIcon = icon(scroll);
export const BookOpenIcon = icon(bookOpen);
export const LibraryIcon = icon(bookBookmark);
export const ChatIcon = icon(comments);
export const ChatTextIcon = icon(commentDots);
export const PulseIcon = icon(waveSquare);
export const SparklesIcon = icon(wandMagicSparkles);
export const LightbulbIcon = icon(lightbulb);
export const KeyIcon = icon(key);
export const BugIcon = icon(bug);
