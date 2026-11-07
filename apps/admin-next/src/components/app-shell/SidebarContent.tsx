import { useQuery } from '@tanstack/react-query';
import { NavMenu } from '@tuuject/koi-react/nav-menu';
import { css } from '@tuuject/koi-react/styled-system/css';
import { useTranslation } from 'react-i18next';
import { versionQuery } from '@/lib/queries';
import { activeNavValue } from '@/nav';
import { useNavMenu } from './use-nav-menu';

interface SidebarContentProps {
  readonly pathname: string;
  /** Collapsed rail (md and up): icons only, each parent opening its pages beside the rail. */
  readonly rail?: boolean;
  readonly onNavigate?: () => void;
}

function VersionFooter(): React.ReactElement {
  const version = useQuery(versionQuery);
  if (version.data === undefined) {
    return <div />;
  }
  return (
    <div data-testid="app-version" className={css({ paddingInline: '2', paddingBlock: '1' })}>
      <div className={css({ fontFamily: 'mono', textStyle: 'small', lineHeight: 'tight', wordBreak: 'break-all' })}>
        {version.data.version}
      </div>
      <div className={css({ textStyle: 'small', color: 'text-muted' })}>{version.data.channel}</div>
    </div>
  );
}

/**
 * The brand and the navigation, shared by the desktop sidebar and the mobile
 * drawer so the two can't drift. NavMenu owns the scroll area and the brand
 * block; the container only supplies the width and the version footer.
 */
export function SidebarContent({ pathname, rail = false, onNavigate }: SidebarContentProps) {
  const { sections, onSelect } = useNavMenu(onNavigate);
  const { t } = useTranslation();

  return (
    <NavMenu
      orientation="vertical"
      brand={{ logo: 'S', title: t('brand.name'), subtitle: t('layout.adminPanel') }}
      sections={sections}
      value={activeNavValue(pathname)}
      collapsed={rail}
      label={t('layout.mainNavigation')}
      footer={<VersionFooter />}
      onSelect={onSelect}
    />
  );
}
